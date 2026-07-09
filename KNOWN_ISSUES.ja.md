# 既知の問題と先送りした作業

このファイルは、初期スライスのレビューで**発見した上で意図的に
先送りした**欠陥・負債を、再発見不要なように追跡するものです。
運用者向けの挙動上の制約は README の「既知の制約」に、こちらは
コントリビューター向けにファイル参照と修正方針を添えて記録します。

[English version](KNOWN_ISSUES.md)

規約: 各項目は「現状の挙動 / 先送りの理由 / 意図する修正」を書き、
修正されたら項目ごと削除します。

## 正確性に隣接する項目 (このスライスでは仕様としての制約)

### Active の vLLM だけが死に supervisor が生きている場合、自動フェイルオーバーしない

- 場所: `services/haru-server/src/reconciler/reconciler.ts`
  (`pollHeartbeats`)、`packages/core/src/failover.ts` (`detectFailover`)。
- 現状: 到達可能だが not-ready な ACTIVE ドメインは `degraded` に
  遷移し (route intent の適格性に反映)、ドメイン状態 `failed` を
  書くコードは存在しないため `detectFailover` の failed 分岐は
  現状到達不能。自動フェイルオーバーはハートビートの鮮度切れでのみ
  発火します。
- 先送りの理由: 一時的に not-ready なだけの active からの自動昇格には
  デバウンスポリシー (`degradedGraceMs` 的な設定や `failed` への
  エスカレーション規則) の設計が必要。外部で route intent の適格性に
  反応すれば当面カバー可能。
- 意図する修正: ポリシー駆動のエスカレーション
  (`degraded が N ms 継続` → `failed`) を追加し、既存の failed
  トリガーを到達可能にする。

### レスポンスヘッダー到達前のクライアント切断が上流へ伝播しない

- 場所: `services/haru-server/src/chat-proxy.ts`、
  `services/haru-server/src/app.ts` (chat ルート)。
- 現状: 上流 fetch を中断するのは TTFB タイマーのみ。ヘッダー到達前
  (特に長い非ストリーミング生成中) にクライアントが切断しても、上流
  リクエストはヘッダー到達かタイマー発火まで走り続けます。
  ストリーム途中の切断は伝播します (パススルーの body ストリームが
  cancel されるため)。
- 先送りの理由: `AbortSignal.any([タイマー, c.req.raw.signal])` の
  導入と両フェーズのテストが必要。当面の無駄は有限
  (放棄リクエストあたり TTFB ウィンドウ 1 回分)。
- 意図する修正: `proxyChatCompletion` でリクエストシグナルと
  タイムアウトシグナルを合成する。

### chat ルーティングは TTL 付きスナップショットキャッシュから配信される (昇格後の staleness は有界)

- 場所: `services/haru-server/src/app.ts` (`cachedSnapshot`、
  `snapshotCacheTtlMs`、既定 2000 ms)。
- 現状: `switch_active` が `activeDomainId` を切り替えた後も、
  キャッシュ済み fleet 参照への chat completions は TTL が切れるまで
  旧 active ドメインへルーティングされうる。`demote_old_sleep` が
  そのドメインを sleep させている最中も含む (該当リクエストは
  502/504 で即時に失敗し、クライアントがリトライする)。
- 先送りの理由: これは見落としではなく意図的な上限。プロセス内の
  キャッシュ無効化フックで直るのは単一インスタンス構成のみ:
  `POST /reconcile` (や 2 台目の haru-server) はこのキャッシュを
  持たないプロセスからポインタを動かせるため、どのみち TTL が
  正直な staleness の上限になる。フェイルオーバーは稀であり、
  ホットパスの大幅な軽量化と引き換えの「リトライ可能なエラー
  最大 2 秒」はこのスライスでは許容と判断した。
- 意図する修正: キャッシュエントリを `routeRevision` でキーし、
  リクエストごとに安価な revision のみの SELECT を行う (ポインタ
  移動は即時反映、重い 3-SELECT スナップショットはキャッシュ維持)。
  加えて、同居する reconciler から `switch_active` 成功後に
  キャッシュをクリアする。

### @haru/core の状態遷移表がランタイムで強制されていない

- 場所: `packages/core/src/slot-state.ts`、
  `packages/core/src/domain-state.ts` と、
  `services/haru-server/src/reconciler/steps.ts` /
  `packages/db/src/repo/slots.ts` のリテラルな from リスト。
- 現状: `canTransitionSlot` / `assertSlotTransition` に本番の呼び出し
  元はなく、リコンサイラは表に無いエッジを意図的に実行します:
  `failed → waking` (昇格失敗後のリトライ)、
  `probing|waking|starting → sleeping` (降格クリーンアップ)、
  `stopping|training → idle` (停止完了)。実行される真実は DB CAS の
  from リスト側です。
- 先送りの理由: `assertSlotTransition` を素朴に repo 層へ組み込むと
  昇格リトライと降格クリーンアップが壊れます。表と実行器は同時に
  整合させる必要があります。
- 意図する修正: core の表にリカバリー/クリーンアップのエッジを追加し、
  各 `transitionDomainSlots` の from リストを「X へのエッジを持つ
  状態集合」として表から導出し、repo 層で強制する。それまでは
  実行器側を真実として扱うこと。

### route intent の適格性と chat proxy のルーティング述語が異なる

- 場所: `packages/core/src/route-intent.ts` (`isDomainRoutable`:
  全 inference スロット serving + `servingBaseUrl` あり) と
  `services/haru-server/src/app.ts` の chat ルート
  (ドメイン ready|degraded + **要求されたモデル**のスロットが serving)。
- 現状: スロットが 1 つ failed のドメインは route intent では
  `eligible: false`、一方 chat proxy は健康なモデルを提供し続ける
  ため、外部ルーティングと haru 自身の入口で判断が食い違います。
- 先送りの理由: どちらの意味論が正しいかはプロダクト判断
  (全か無かのルータビリティ vs モデル単位のデグレード)。
- 意図する修正: バインディング単位のルータビリティ判定を core が
  所有して両者が使い、`RouteIntent` をモデル単位の適格性に拡張する。

### 自動フェイルオーバーの昇格先が slug 順の先頭 standby

- 場所: `packages/core/src/failover.ts` (`detectFailover`)。順序は
  `packages/db/src/repo/snapshots.ts` の `orderBy(domains.slug)` 由来。
  `buildRouteIntent` の単一 `standby` フィールドも同じバイアス。
- 現状: standby の選択が健康度ではなく slug ソートの副産物。
- 先送りの理由: 2 ドメイン構成 (standby は 1 つ) では問題にならない。
  ランキングポリシーは 3 ドメイン以上対応と一緒に設計すべき。
- 意図する修正: core に明示的な standby ランキング (状態、最終確認、
  必要なら probe の鮮度) と `standbys: RouteTarget[]` 形状を導入。

## テストの妥当性

### PGlite は「並行」CAS テストを直列化する

- 場所: `packages/db/src/cas.test.ts`、
  `packages/db/src/operations.test.ts` (Promise.all のレース)、
  ハーネスは `packages/db/src/testing/index.ts`。
- 現状: PGlite は単一接続のため Promise.all のレースは直列実行。
  テストが証明するのは逐次インターリーブ下の勝敗セマンティクスで、
  真の並行下の行ロック待ち + 述語再評価ではありません。本番文は
  単一 `UPDATE ... WHERE` (Neon の READ COMMITTED 下でアトミック)
  なので設計自体は健全ですが、CAS を read-then-write に分割する
  リファクタをこのテストは検出できません。
- 意図する修正: 実 Postgres (CI のサービスコンテナ) に対して同じ
  スイートを流すオプションの統合レーン。

## 効率の改善バックログ (正確性への影響なし)

いずれも Neon-HTTP のラウンドトリップまたは実時間の無駄で、状態を
壊すものではありません。

- **ハートビートの逐次ポーリング** — `pollHeartbeats` がドメインを
  1 つずつ await (各 5s タイムアウト)。修正: ドメイン across の
  `Promise.allSettled`。
- **tick ごとのスナップショット二重ロード** — `reconcileFleet` が
  ハートビート後に全スナップショットを再ロード。修正: ハートビート
  結果でメモリ上のスナップショットを更新するか、CAS が行を変えた
  ときのみ再ロード。
- **getFleetSnapshot が 3 連続 SELECT** — fleet → domains → slots
  (`packages/db/src/repo/snapshots.ts`)。chat proxy がキャッシュ
  ミスごとに支払う。修正: slots をサブクエリ/JOIN 化し domains と
  並列化。
- **オペレーション行を tick あたり最大 3 回再読** —
  `advanceInFlightOperation`。修正: `claimOperation` の
  `.returning()` を全行に広げ、手元の行を再利用。
- **nudge ごとの無条件ミラー UPDATE** — `stop_training` /
  `wake_vllm` がリトライのたびに 0 行 UPDATE を発行。修正: tick の
  スナップショットのスロット状態を見てから書く。
- **supervisor の status がスロット間で逐次** —
  `services/haru-supervisor/src/app.ts slotStatuses`。修正: 全体を
  1 つの `Promise.all` に平坦化。
- **sleep/wake のモデル間逐次実行** — 複数モデルのホストでは
  リコンサイラの 10s nudge タイムアウトを超え、冪等リトライ頼みに
  なる。修正: モデル across の `Promise.allSettled` (エラー封筒用の
  全件試行は維持)。
- **テストごとの PGlite 起動** — DB 系テストの `beforeEach` が毎回
  PGlite 起動 + マイグレーション再生 (`pnpm test` の支配的コスト)。
  修正: ファイル単位 `beforeAll` + テスト単位 TRUNCATE、または
  `dumpDataDir`/`loadDataDir` によるクローン。

## 重複 / デッドコードのバックログ

- **Bearer 認証が 2 サービスに重複** —
  `services/haru-server/src/auth.ts` と
  `services/haru-supervisor/src/app.ts` のインライン版 +
  `isSameSecret`。セキュリティ境界の重複であり、片側だけの強化が
  静かにもう片側を取り残します。修正: `isSameSecret` と
  フレームワーク非依存の bearer チェックを `@haru/protocol` へ
  (node:crypto のみ。supervisor の protocol-only 依存規則にも適合)。
- **readJsonBody の重複 (差分が仕様)** — haru-server は不正 JSON を
  `null` に (必須フィールドスキーマが拒否)、supervisor は `{}` に
  (全 optional スキーマがボディ無し POST を受理)。修正: フォール
  バック値を引数にした単一ヘルパを `@haru/protocol` に置き、差分を
  明示化。
- **`runSky` + 一時 YAML 書き出し + タイムアウト既定値がドライバー間で重複** —
  `driver-skypilot/src/driver.ts` と `driver-skyserve/src/driver.ts`。
  修正: 共有 exec モジュールの隣に `createSkyRunner(exec, timeouts)`
  と `writeTempYaml` を持ち上げる。
- **execFile ラッパの重複** — `driver-skypilot/src/exec.ts`
  (`defaultExec`) と `services/haru-supervisor/src/main.ts`
  (`realExec`)。オプションが既に乖離 (maxBuffer vs timeout)。
  修正: `@haru/protocol` へ (builtin のみ)。
- **AbortController+timer の fetch 足場が 4 箇所で手書き** —
  supervisor-client / chat-proxy / vllm-client / probe。修正:
  `@haru/protocol` に `fetchWithTimeout` を用意し、エラーの意味付けは
  各所に残す。
- **テストヘルパの重複** — `requestTarget` (haru-server の fake
  ヘルパと supervisor の app.test) と fleet サンプル JSON ローダー
  (db の 3 テストファイル)。修正: `@haru/db/testing` の隣に共有
  テストユーティリティ。
- **書き込み専用の `operations.attempt` カラム** — pending の nudge
  ごとに加算 (`bumpAttempt`)、claim/advance でリセット、読む者なし
  (ステップの打ち切りは実時間ベース)。修正: 削除するか、可観測性が
  必要なら events ストリームへ記録。
- **未使用の protocol エクスポート** — `promoteNoopResponseSchema`、
  `operationAcceptedResponseSchema`、`readyResponseSchema`、
  `apiErrorBodySchema` に消費者なし (サーバーはレスポンスリテラルを
  インラインで構築)。修正: リテラルを `satisfies` でこれらの型に
  結び付けるか削除 (公開ワイヤ契約なので前者を推奨)。
- **`snapshotCacheTtlMs` に設定手段がない** — `AppConfig` にあるが
  env 配線なし (`chatHeaderTimeoutMs` と非対称)。キャッシュキーも
  生のフリート参照のため slug と UUID のエントリが独立に失効。
  修正: env を配線するか定数化し、キーを正規化。
- **reconciler のタイムアウトパスが outcome switch を複製** —
  `handleStepTimeout` の advance/complete と fail/cleanup が
  `executeStep` 側の処理を鏡写し。修正: タイムアウトを `StepOutcome`
  に変換して単一経路に流す (現状、タイムアウトで advance した
  best-effort ステップは `operation.step.done` イベントを出さない
  非一貫性がある)。
- **SupervisorError→outcome 変換の前段が実行器ごとにコピー** —
  try/catch は `supervisorFailure` に集約済みだが、
  targetDomain/options の前置きは 8 実行器に残る。修正:
  `withTargetSupervisor` ラッパ。
