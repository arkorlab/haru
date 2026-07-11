# Haru

**Haru** は、LLM 推論フリートのための GPU ハードウェア抽象化レイヤー
(HAL) です。オペレーティングシステムにおける HAL の役割に着想を得て
います。雑多で不均質な GPU インフラの上に、小さく安定した、
プロバイダー中立な操作面を上位システムへ提供します。名前は日本語の
「はる (春)」とも読めます。

[English README](README.md)

## Haru が存在する理由

LLM 推論をホストするプロダクトには GPU ライフサイクル管理が必要です。
マシンのプロビジョニング、ランタイムの監視、リージョン間の
フェイルオーバー、トラフィックの向き先の決定。このロジックを
プロダクトのコントロールプレーンに埋め込むと、特定のデプロイメントと
特定のプロバイダーに結合してしまいます。Haru はそれを独自の状態
ストアを持つ独立したレイヤーとして切り出します。プロダクトの
コントロールプレーンはユーザー・カタログ・メタデータに集中したまま、
小さな HTTP API を通じて Haru を利用できます。

## Active/Standby アーキテクチャ

Haru の最初のミッションは、アイドル GPU ゼロのコストで実現する
セルフホスト LLM 推論のホットフェイルオーバーです:

- **Active** ドメインが OpenAI 互換の推論トラフィックを提供します。
- **Standby** ドメインは同じモデルランタイムを保持したまま、vLLM を
  **[レベル 1 スリープモード](https://vllm.ai/blog/2025-10-26-sleep-mode)**
  に入れます: サーバープロセスは生きたまま、モデル重みは CPU RAM に
  退避され、KV キャッシュは破棄されます。これにより Standby GPU の
  VRAM が解放され、待機中はそこで**プリエンプティブルな LoRA 学習**を
  実行します。
- Active ドメインに障害が起きると、Haru は Standby を昇格させます:

  1. LoRA 学習を停止する (SIGTERM、猶予期間の後に SIGKILL。
     チェックポイント保存は猶予内のベストエフォートで、フェイルオーバーが
     完璧なチェックポイントを待つことは**決してありません** - 学習側は
     チェックポイント/レジューム前提であることが要求されます)、
  2. GPU が学習の VRAM を実際に解放したことを確認する、
  3. vLLM を起こす (レベル 1 スリープは最速の復帰パスです:
     重みはディスクではなく CPU RAM から戻ります)、
  4. 全モデルに対して合成推論プローブを実行する、
  5. ルーティングポインターを切り替える (データベースの単一
     compare-and-swap)、
  6. ベストエフォート: 旧 Active をスリープさせ、学習ワークロードを
     引き継がせる。

  ステップ 5 より前に失敗した昇格がルーティングを動かすことは
  ありません: 旧 Active が提供を続けます。

想定しているレイアウトは、1 つの GPU が複数の小型モデルのバンドル
(モデルごとに 1 つの vLLM サーバー) をホストし、もう 1 つの GPU が
大型モデル 1 つをホストする構成を、2 つの障害ドメイン (異なる
リージョンまたは異なるクラウド) にミラーしたものです。Haru 自体は
これを一切ハードコードしません: フリート、ドメイン、スロット、
モデル、配置はすべてデータです。

## レイヤリング: SkyPilot、SkyServe、Haru

- **[SkyPilot](https://skypilot.readthedocs.io/)** は下位のマルチ
  クラウド GPU プロビジョニングレイヤーです。Haru は GPU ドメインの
  作成・停止・確認を SkyPilot に依頼します。AWS/GCP・リージョン・
  スポット・GPU の制約は SkyPilot のタスク設定として表現され、
  クラウド API を直接呼ぶことはありません。
- **[SkyServe](https://skypilot.readthedocs.io/en/latest/serving/sky-serve.html)**
  はサービング指向のオーケストレーションレイヤーです: レプリカ、
  配置、リカバリー、ロードバランシング。
- **Haru** はどちらも置き換えない上位の GPU HAL です:
  Fleet/Domain/Slot の状態、Active/Standby の昇格、Standby の
  スリープ + 学習ライフサイクル、route intent、ランタイム監視を
  所有します。

## コアコンセプト

| 概念 | 意味 |
| --- | --- |
| **Fleet** | 1 つの Active/Standby 単位: ドメインの集合と、唯一の正であるルーティングポインター `activeDomainId`、およびポリシー (タイムアウト、auto-failover)。 |
| **Domain** | 1 つの障害ドメイン: プロビジョニングされた GPU マシン/クラスター (SkyPilot クラスター、SkyServe サービス、または静的にプロビジョニングされたホスト)。スーパーバイザーとサービング用ベース URL を持ちます。 |
| **Slot** | 1 GPU 上の 1 ワークロード: `inference` スロット (その GPU が提供するモデル群。モデルごとに vLLM サーバー) または `training` スロット (ドメインが Standby の間に実行されるプリエンプティブルな LoRA ジョブ)。 |
| **Driver** | プロビジョニング境界 (`@haru/driver-skypilot`、`@haru/driver-skyserve`): ドメイン/サービス仕様を SkyPilot/SkyServe の YAML に変換し、注入可能でテスト可能な exec 関数の背後で `sky` CLI をラップします。 |
| **Supervisor** | ドメインごとのエージェント (`services/haru-supervisor`): vLLM の sleep/wake オーケストレーション、猶予/SIGKILL エスカレーション付きの学習開始/停止、GPU メモリ確認、合成プローブ、readiness。 |
| **RouteIntent** | プロバイダー中立なルーティングの答え (`active`/`standby` ターゲット、適格性、重み、リビジョン)。外部のルーティングレイヤーが消費します。Haru はルーターベンダー固有のロジックを持ちません。 |

## リポジトリ構成

```text
packages/protocol         Zod スキーマ / 型付き API 契約 (型の単一情報源)
packages/core             純粋な状態機械、昇格プランニング、route intent
packages/db               Neon/Postgres 状態ストア (Drizzle スキーマ、マイグレーション、
                          compare-and-swap リポジトリ、PGlite テストハーネス)
packages/driver-skypilot  SkyPilot ドライバー境界
packages/driver-skyserve  SkyServe ドライバー境界
services/haru-server      コントロール API + reconciler + OpenAI 互換 chat proxy
services/haru-supervisor  GPU ドメイン側スーパーバイザー
```

### 状態モデルの要約

サーバーが永続的な真実を所有し、スーパーバイザーが実行を所有します。
すべての状態遷移は単文の compare-and-swap (`UPDATE ... WHERE state IN
(...) RETURNING`) で、Neon HTTP ドライバー (対話的トランザクション
なし) でもテストの PGlite でも同一に動作します。外部操作 (SkyPilot
プロビジョニング、vLLM の wake、プローブ) が DB トランザクション内で
実行されることはありません。昇格と降格は `operations` 行で、部分
unique index が「フリートあたり同時 1 オペレーション」を強制します。
reconciler は再入可能な check-and-nudge 実行器で現在のステップを
進めるため、並行する tick は安全に競合し、クラッシュしたステップは
冪等に再開します。

## データベース: Neon ファースト

`@haru/db` は、ドキュメント化されテストされた本番データベースとして
[Neon](https://neon.tech) を `drizzle-orm/neon-http` 経由で対象と
します。SQL は意図的にポータブルな PostgreSQL です: テストスイートは
コミット済みマイグレーションをインメモリの PGlite に対して実行し、
「すべての書き込みは単文」という HTTP ドライバーの制約以外に
Neon 固有の機能は使いません。

```bash
pnpm db:generate   # drizzle-kit generate (packages/db/drizzle にコミット)
pnpm db:push       # スキーマを $DATABASE_URL に push
pnpm db:seed       # 宣言的なレイアウト JSON からフリートをシード
```

## API 表面 (haru-server)

| ルート | 目的 |
| --- | --- |
| `GET /healthz` | 死活確認。 |
| `GET /v1/fleets/:fleetId` | フリートの完全なスナップショット (slug または UUID)。 |
| `POST /v1/fleets/:fleetId/reconcile` | reconcile を 1 tick 実行 (ハートビート、auto-failover、オペレーション 1 ステップ)。 |
| `POST /v1/fleets/:fleetId/promote` | ドメインを Active に昇格 (冪等。既に Active なら 200 no-op、202 受理/合流、409 進行中オペレーションと衝突)。 |
| `POST /v1/fleets/:fleetId/demote` | Standby をスリープさせて学習を開始 (Active ドメインを直接降格することはできません)。 |
| `GET /v1/fleets/:fleetId/route-intent` | プロバイダー中立なルーティングの答え。 |
| `POST /v1/chat/completions` | Active ドメインへの OpenAI 互換ストリーミングプロキシ (フリートは `X-Haru-Fleet` ヘッダーまたは `HARU_DEFAULT_FLEET` で選択)。 |

認証: `HARU_API_TOKEN` を設定し、`Authorization: Bearer <token>` を
送ってください。未設定は未認証を意味し、サーバーは大きな警告をログに
出した上で 127.0.0.1 のみで listen します (ローカル開発モード。
`HARU_SUPERVISOR_TOKEN` 未設定時のスーパーバイザーも同じ規則です)。
サーバーとスーパーバイザーの間は別の `HARU_SUPERVISOR_TOKEN` を
使います。

### haru-server の環境変数

| 変数 | 目的 |
| --- | --- |
| `DATABASE_URL` | Neon/Postgres の接続文字列 (必須)。 |
| `PORT` | リッスンポート (デフォルト 8700)。 |
| `HARU_API_TOKEN` | 公開 API の Bearer トークン。未設定 = オープンかつ 127.0.0.1 のみで listen (開発のみ)。 |
| `HARU_SUPERVISOR_TOKEN` | ドメインのスーパーバイザーへ提示する Bearer トークン。 |
| `HARU_DEFAULT_FLEET` | `X-Haru-Fleet` ヘッダーなしの `/v1/chat/completions` が使うフリート。 |
| `HARU_CHAT_HEADER_TIMEOUT_MS` | chat proxy の TTFB 上限 (デフォルト 30000)。**非ストリーミング**の長い補完ではレスポンスヘッダーが生成完了後にしか届かないため、必要に応じて引き上げてください。設定値はそのまま正確に効きます: chat トラフィックは専用 dispatcher 上で動き、undici 自身の headers/body アイドルタイマーを無効化しているため、300 秒での頭打ちはなく、生成途中で静かになるストリーミングボディがトランスポート側に切断されることもありません。 |
| `HARU_SNAPSHOT_CACHE_TTL_MS` | chat ホットパスのフリートスナップショットキャッシュ TTL (デフォルト 2000)。ルーティングポインターの移動はこれと無関係に即時反映されます (毎リクエストで route revision を再検証)。この TTL が上限を与えるのはスロット状態などの非ルーティングな staleness だけです。 |
| `HARU_RECONCILE_INTERVAL_MS` | この間隔でバックグラウンド reconcile ループを有効化。**未設定はループなし**: その場合ハートビート・`autoFailover`・オペレーション進行は、何か (外部 cron など) が `POST /v1/fleets/:id/reconcile` を叩いたときにだけ動きます。 |
| `HARU_RECONCILE_FLEETS` | ループが reconcile するフリート slug のカンマ区切り (`HARU_DEFAULT_FLEET` にフォールバック)。 |

スーパーバイザーは `PORT` (デフォルト 8701)、`HARU_SUPERVISOR_TOKEN`、
`HARU_SUPERVISOR_CONFIG` (インライン JSON またはファイルパス) を読みます。
シードスクリプトは `DATABASE_URL` と、任意で `HARU_FLEET_LAYOUT` を読みます。

### chat proxy のコンシューマー契約

- 通常の OpenAI スタイルの JSON ボディで `POST /v1/chat/completions`。
  `model` が Active ドメイン上のサービング vLLM インスタンスを選択し、
  それ以外のフィールド (ベンダー拡張を含む) はバイト単位でそのまま
  転送されます。
- `X-Haru-Fleet: <slug-or-uuid>` でフリートを選択。なければ
  `HARU_DEFAULT_FLEET` にフォールバックします。
- レスポンスは無加工でストリームされます (SSE または JSON)。エラーは
  `{ "error": { "code", "message" } }` の形で、コードは
  `fleet_not_found`、`model_not_found`、`no_active_domain`、
  `upstream_timeout`、`upstream_unreachable` など。

## vLLM の要件 (スーパーバイザーのホスト)

Haru スーパーバイザーが管理するすべての vLLM サーバーは、次の条件で
起動する必要があります:

- `--enable-sleep-mode` と `VLLM_SERVER_DEV_MODE=1` (sleep/wake の
  管理エンドポイントは開発モードのエンドポイントです)、
- `127.0.0.1` のみにバインド。

sleep/wake/is_sleeping エンドポイントは**プライベートでローカル限定の
コントロール**です。ホストの外に公開されることはありません。
スーパーバイザーの認証付き API が唯一の外部コントロール面であり、
haru-server の chat proxy は構造的にそこへ到達できません
(`/v1/chat/completions` のパスしか構築しないためです)。デプロイする
vLLM バージョンに対してエンドポイントのパスを確認してください。
このリポジトリでは `services/haru-supervisor/src/vllm-client.ts` に
挙動を固定しています。

## 垂直スライスを試す (GPU 不要)

`provider: "static"` のドメインはドライバーを完全にスキップするため、
コントロールループ全体を任意の OpenAI 互換エンドポイントに対して
動かせます:

```bash
pnpm install && pnpm build

# 1. DATABASE_URL を Neon データベースに向けてスキーマを適用。
pnpm db:push

# 2. 同梱のジェネリックな 2 ドメインのサンプルレイアウトをシード
#    (packages/db/examples/fleet.example.json)。自前のものも指定可:
pnpm db:seed            # または: pnpm db:seed -- --config my-fleet.json

# 3. サーバーを起動 (turbo がワークスペース依存を先にビルド)。
HARU_DEFAULT_FLEET=default pnpm dev --filter=@haru/server

# 4. 話しかける。
curl -s localhost:8700/v1/fleets/default/route-intent
curl -s localhost:8700/v1/chat/completions \
  -H 'content-type: application/json' -H 'x-haru-fleet: default' \
  -d '{"model":"example-chat-small","messages":[{"role":"user","content":"hi"}]}'
curl -s -X POST localhost:8700/v1/fleets/default/promote \
  -H 'content-type: application/json' \
  -d '{"targetDomainId":"<フリートスナップショットの standby ドメイン id>"}'
curl -s -X POST localhost:8700/v1/fleets/default/reconcile  # 完了まで繰り返す
```

## 開発

```bash
pnpm install
pnpm build          # turbo run build (トポロジカル順)
pnpm typecheck      # 全体で tsc --noEmit
pnpm lint           # oxlint --type-aware --deny-warnings の後、型情報ベースの strict ESLint
pnpm format         # oxfmt --write
pnpm format:check   # CI ゲート
pnpm test           # 全体で vitest (PGlite ベースの DB / server テスト)
```

TypeScript 7 (`tsc`) がコードのビルドと型チェックを行います。
typescript-eslint の型情報ベース lint のためだけに、ワークスペース
ルートに TypeScript 6.x のコピーがインストールされています (対応
peer レンジがまだ `<6.1.0` のため)。typescript-eslint が TS 7 に
対応したらこのコピーは削除してください (`pnpm-workspace.yaml` の
コメント参照)。oxlint の型情報ベースルールは、どちらのコピーとも
独立に、tsgo ベースの `oxlint-tsgolint` バイナリを通じて実行されます。

開発規約と PR ガイドラインは [CONTRIBUTING.ja.md](CONTRIBUTING.ja.md)
([English](CONTRIBUTING.md)) を参照してください。

## 既知の制約 (このスライス)

コントリビューター向けの先送り作業は、ファイル参照と修正方針付きで
[KNOWN_ISSUES.ja.md](KNOWN_ISSUES.ja.md) に記録しています。

- **自動フェイルオーバーには reconcile の駆動が必要です。**
  `HARU_RECONCILE_INTERVAL_MS` (+ `HARU_RECONCILE_FLEETS`) を設定
  するか、外部 cron から `POST /v1/fleets/:id/reconcile` を叩いて
  ください。どちらも無ければ `autoFailover` ポリシーは動きません。
- **到達可能だがモデルが死んでいる Active のフェイルオーバーは
  `degradedGraceMs` 経過後です。** Active のスーパーバイザーが
  応答するのにモデルが serving でない場合、ドメインは即座に
  `degraded` になり (route intent に反映)、そのままポリシーの猶予
  (デフォルト 60 秒) を超えると `failed` にエスカレートして
  (autoFailover 有効時) 自動フェイルオーバーが発火します。
  `degradedGraceMs` で調整してください。
- **モデルバインディング名は小文字のルーティングキーです。** 各
  バインディングの背後の vLLM サーバーも同じ小文字名で提供する必要が
  あります (例: `--served-model-name`)。chat proxy は完全一致で
  照合し、クライアントのボディをそのまま転送します。
- **GPU メモリ検証は `nvidia-smi` の数値出力が前提です。** メモリ
  フィールドに `[N/A]` を返す MIG パーティションの GPU は、
  `verify_gpu` ステップでは未サポートです。
- **レイアウトの再適用は既存行を更新しません** (フリートポリシー、
  表示名、既存スロットの spec)。シードは設計上 insert のみです。
  **新規追加**スロットの状態はライブなルーティングポインターに
  従います。
- **chat ルーティングは非ルーティングな状態変化をスナップショット
  キャッシュ TTL (`HARU_SNAPSHOT_CACHE_TTL_MS`、デフォルト 2 秒)
  まで遅れて反映することがあります。** ルーティングポインターの
  移動は例外です: 毎リクエストでフリートの route revision を
  再検証するため、昇格後の chat トラフィックは即座に切り替わります。

## 意図的にスコープ外 (現時点)

- **AWS/GCP の直接プロバイダー。** ドライバーは SkyPilot と SkyServe
  のみです。クラウドは配置制約であり、インテグレーションでは
  ありません。
- **ルーター/DNS/プロキシのリコンシリエーション。** Haru は
  プロバイダー中立な route intent を出力します。それに基づく操作
  (DNS、エッジプロキシ、CDN 設定) はコンシューマー側の責務です。
- **reconciler でのドライバーによるプロビジョニング。** ドライバーは
  完成したテスト済みの境界ですが、reconciler が現在管理するのは
  静的にプロビジョニングされたドメインです。`provider: skypilot |
  skyserve` のドメインを launch/teardown ステップに接続するのは
  次のスライスです。
- **フリートあたり 3 ドメイン以上**、重み付き/カナリアルーティング、
  マルチフリートスケジューリング。
