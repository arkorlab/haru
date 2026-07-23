# 既知の問題と先送りした作業

このファイルは、レビューで**発見した上で意図的に先送りした**
欠陥・負債を、再発見不要なように追跡するものです。運用者向けの
挙動上の制約は README の「既知の制約」に、こちらはコントリビューター
向けにファイル参照と修正方針を添えて記録します。

[English version](KNOWN_ISSUES.md)

規約: 各項目は「現状の挙動 / 先送りの理由 / 意図する修正」を書き、
修正されたら項目ごと削除します。

## 先送り (レビュー後のバックログ)

### chat スナップショットキャッシュにサイズ上限がない

- 場所: `services/haru-server/src/app.ts` (`snapshotCache`。加えて
  同じ寿命を共有する `fleetIdByReference` / `forgottenGenerations` /
  `referenceVerdictGenerations` マップ)。
- 現状: store が「フリートは存在しない」と答えたときの削除と、
  使用不能と判明したエントリの隔離 (`forgetFleet`) は実装済み。
  ただし単に参照されなくなっただけのフリートは、最終 FleetSnapshot
  がプロセス寿命の間残る。上限は「これまでに配信したフリート数」。
- 先送りの理由: このスライスではフリートは少数かつ長寿命。
- 意図する修正: 小さな LRU 上限。注意: 削除は store が「そう言った」
  ことだけを根拠にすること (null lookup、使用不能なスナップショット)。
  lookup の throw を根拠にしてはいけない。throw は store 到達不能を
  意味し、そのエントリこそ chat proxy の fail-open 経路が配信する
  当のものだから (同ファイルの `failOpen`)。

### chat 経路の障害検知レイテンシに上限がない

- 場所: `services/haru-server/src/app.ts` (`cachedSnapshot` が
  `getFleetRoutePointer` を呼ぶ箇所)。
- 現状: pointer 読み取りに timeout / AbortSignal がなく、障害状態の
  メモ化もない。そのためハング型の障害 (TCP は受けるが応答しない)
  では、fail-open が発動する前に毎リクエストがトランスポート自身の
  失敗を待つ (最悪 undici のヘッダータイムアウトまで、リクエスト
  ごとに TTFB として支払う)。即時失敗型の障害 (connection refused)
  はほぼ即座で影響なし。
- 先送りの理由: 検知の上限は設計判断 (固定バジェット / 設定ノブ /
  サーキットブレーカー) であり、このスライスは意図的に新しい env
  ノブを増やさない。よくある障害モード (エンドポイント停止) は
  即時失敗する。
- 意図する修正: pointer 読み取りへの小さな固定 AbortSignal
  バジェット (健全時 p99 より十分上)。加えて短寿命の「store 停止中」
  メモで後続リクエストを直接キャッシュへ向かわせてもよい。いずれも
  「fail-open を許可するのは pointer 読み取りの失敗だけ」という
  規則を保つこと。

### fail-closed の chat エラーはリクエストごとにログされる

- 場所: `services/haru-server/src/app.ts` (`failOpen` のコールド
  キャッシュ分岐と `snapshotLoadFailed`)。
- 現状: stale 配信の遷移は `staleFleetIds` で重複排除済みだが、
  fail-closed の 503 経路 2 つは毎リクエスト `console.error` する:
  コールド (または隔離済み) フリートへの障害中リクエストは
  リクエストごとに、永続状態が壊れたフリートはデータ修復まで
  リロード試行ごとにログが出る。
- 先送りの理由: 重複排除には参照ごとの状態とクリア規則が必要で、
  洪水はリクエストが既に失敗している間しか起きない。
- 意図する修正: 参照をキーにした遷移型ログ (初回失敗でログ、次の
  成功でクリア)。`staleFleetIds` と同じ作法。

### pointer 読み取りの部分失敗は「id は否認済み」という半分の判定を捨てる

- 場所: `packages/db/src/repo/snapshots.ts` (`lookupFleetByReference`)。
  消費側は `services/haru-server/src/app.ts` の `cachedSnapshot` /
  `failOpen`。
- 現状: UUID 形の参照は 2 つのクエリを順に実行する。by-id クエリが
  空結果で成功し (store がその id を否認した直後)、slug フォール
  バックのクエリが throw した場合、呼び出し側には throw しか見えず
  fail-open する。その結果、id-first のキャッシュ探索が、1 クエリ前に
  store が否認したフリートを配信しうる。
- 先送りの理由: 1 リクエスト内の 2 サブクエリの間で store が落ち、
  かつ参照が「削除直後でこのプロセスにまだキャッシュされている
  フリート」を指す必要がある。次の成功読み取りでキャッシュは治る。
- 意図する修正: pointer 読み取りから部分的な証拠を表面化する
  (「id 側は否認済み」を運ぶ型付きエラー)。`failOpen` は alias 経路を
  保ちつつ id キーの探索をスキップできる。

### キャッシュミス経路で fleet 行を二重取得している

- 場所: `services/haru-server/src/app.ts` (`cachedSnapshot`) が
  `getFleetRoutePointer` の後に `getFleetSnapshot` を呼ぶ箇所。
- 現状: ミス時に fleet 行を 2 回読む (narrow 1 回 + snapshot 内で
  full 1 回)。TTL ウィンドウごとフリートごとに余分な SELECT 1 回。
- 先送りの理由: ホットパス (ヒット) は既に最小で、ミスは TTL で
  有界。
- 意図する修正: 取得済み fleet 行を受け取る内部スナップショット
  ローダー。

### 失敗した昇格はターゲットを standby 姿勢に戻さない

- 場所: `services/haru-server/src/reconciler/reconciler.ts`
  (`applyStepResolution` の失敗パス、`markFailedPromotionSlots`)。
- 現状: ターゲットを wake した後に失敗した promote (例:
  `probe_failed`) は、ターゲットの inference スロットを failed に
  して終了する。standby 姿勢 (vLLM sleep + 学習稼働) へ自動では
  戻らない。手動で `POST /v1/fleets/:id/demote` を叩けば復旧する。
  (`stop_training` での失敗は対応済み:
  `failOperationWithPromotionCleanup` が同一文でターゲットの
  `stopping` 学習スロットを `training` に戻すため、残るのは wake 後の
  inference スロットのケースのみ。)
- 先送りの理由: 自動復旧はそれ自体が小さなオペレーション (証明付き
  sleep + 学習開始) であり、失敗パスに直付けするとステップ機構の
  外で長い supervisor 呼び出しを走らせることになる。
- 意図する修正: 操作失敗後に対象への demote をキューする (既存の
  demote ステップを再利用)。それまでは運用手順書に記載。

### promotion 進行中に seed したスロットは誤った姿勢で残りうる

- 場所: `packages/db/src/repo/layout.ts` (`applyFleetLayout`) と
  `services/haru-server/src/reconciler/steps.ts` の promotion ステップ。
- 現状: 新しい inference スロットの初期姿勢は INSERT 文内でライブの
  ルーティングポインタに対して評価される (挿入自体はポインタと
  レースしない)。seed と操作の残余ウィンドウは両方向に残る:
  - promote が既に `wake_vllm` を過ぎた時点で挿入されたスロットは
    (その瞬間は standby なので) 正しく `sleeping` で播種されるが、
    promotion は `switch_active` 前にターゲットを再走査しないため、
    ドメインは sleeping スロットを抱えたまま active になり、何も
    自己修復しない (ハートビートミラーは定常ペアのみ)。demote/
    promote 一巡で回復する。
  - 逆に、`switch_active` コミット直前に現 active へ `serving` で
    播種されたスロットは、新 standby に serving のまま残る。
    こちらは概ね自己修復する: promotion のベストエフォート
    `demote_old_sleep` と以後の `sleep_vllm` が単一文 CAS で
    `serving -> sleeping` を一括遷移し、standby の serving スロットは
    ルーティングされない (standby ターゲットは強制的に ineligible)。
    sleep ステップを既に過ぎた操作の場合のみ、次の demote まで残留。
- 先送りの理由: 修正は操作レベルの設計判断 (`switch_active` の
  ナッジでターゲットのスロット集合を再検証してルーティング CAS に
  追加ガードを載せるか、レイアウト適用を one-in-flight 操作スロットと
  直列化するか)。seed とポインタを `db.transaction()` で包む案は
  不可 (Neon HTTP ドライバに対話的トランザクションはなく実行時に
  throw する)。promotion 中のライブフリートへの seed は異例の
  オペレータ操作。
- 意図する修正: `switch_active` エグゼキュータが tick スナップショット
  からターゲットの inference スロットを再導出し、`serving` でない
  ものがある間はコミットを拒否する (通常の pending 経路で収束)。
  もしくは runbook に seed と操作の相互排他を明記する。

### フリートレイアウトの再適用は削除されたドメイン/スロットを消さない

- 場所: `packages/db/src/repo/layout.ts` (`applyFleetLayout`)。
- 現状: レイアウト適用は冪等・追加専用 (`ON CONFLICT DO NOTHING`):
  既存行は触らず新規行のみ挿入するので、シード再実行がライブ状態を
  リセットすることはない。しかしレイアウトからドメインやスロットを
  「削除」した再適用でも、消えた行は削除されず残り、なお数えられ得る
  (例: 古い standby ドメインが `detectFailover` の viable-standby
  述語に混入)。
- 先送りの理由: 削除は単純な追加シードではない。落としたドメインが
  ライブの active ポインタや操作中である可能性があり、安全な除去には
  専用のガード付き teardown フロー (とクラウド資源を解放するための
  ドライバー) が要る。シード経路は意図的に非破壊。
- 意図する修正: レイアウトとライブ行を差分し、削除対象のドメイン/
  スロットをガード付き状態機械経由で撤去する (素の DELETE は使わない)
  独立した宣言的 reconcile。それまでは廃止用の運用手順書で対応。

### Postgres テストレーンはテストごとにマイグレーションを再実行する

- 場所: `packages/db/src/testing/index.ts`
  (`createPostgresTestDatabase`)。
- 現状: 各テストが DB を作成してコミット済みマイグレーション一式を
  再実行する。PGlite レーンには migrate-once 最適化を入れたが CI
  レーンには未適用。
- 先送りの理由: コミット済みマイグレーションはまだ少数 (3 ファイル)
  で、テストあたりのコストは穏当。
- 意図する修正: 実行ごとに seed DB を 1 回 migrate し、テストごとに
  `CREATE DATABASE ... TEMPLATE seed` (ファイルコピーで再実行を
  スキップ)。seed はグローバル teardown で drop。

### SkyServe のステータスは人間向け CLI テーブルからスクレイプしている

- 場所: `packages/driver-skyserve/src/driver.ts`
  (`getServiceStatus`)。
- 現状: `sky serve status` には機械可読な出力フラグがない
  (`sky status --output json` と違い)。そのためドライバーは ANSI
  コードを除去し、サービスのテーブル行をドキュメント化された
  ステータス語彙と照合している。SkyPilot リリース間のテーブル
  レイアウト変更で行マッチが壊れる可能性がある (未知のステータスは
  すでに型付きエラーとして表面化する)。
- 先送りの理由: 現時点で上流にこれより良い手段がなく、reconciler は
  まだ SkyServe のプロビジョニングを駆動していない。
- 意図する修正: 上流が `sky serve status` に出力フォーマットフラグを
  追加した時点で切り替える (SkyPilot CLI リファレンスを追跡)。

### SkyPilot の getDomainStatus は未知クラスタで null でなく throw しうる

- 場所: `packages/driver-skypilot/src/driver.ts` (`getDomainStatus`)。
- 現状: このメソッドが `null` を返すのは、`sky status --output json`
  が「成功」しつつ配列にクラスタが無い場合だけ。未知クラスタで
  `sky status` が非ゼロ終了する場合 (pin したバージョンでは未検証)、
  先に `createSkyRunner` が `SkyCliError` を throw するため、「未検出=
  null」を期待する呼び出し側は例外を受け取る。
- 先送りの理由: 終了コードの挙動は pin した SkyPilot バージョンに
  依存し、reconciler はまだ SkyPilot のプロビジョニングを駆動しない。
- 意図する修正: ドキュメント化されたバージョンに対する「未知クラスタ」
  挙動をテストで固定し、非ゼロ終了ならそのケースだけ `null` に
  マップする。

### publishability ゲートはモデル/GPU 名を対象とするが利用者組織の識別子は対象外

- 場所: `packages/db/src/publishability.test.ts`。
- 現状: このゲートはソースとサンプルレイアウトを走査し、特定の GPU
  モデル識別子と LLM モデルファミリーの denylist を照合するが、本
  プロジェクトの利用者 (consumers) の非公開リポジトリやインフラの
  識別子は走査しない。ツリー内に存在する組織名は本リポジトリ自身の
  publisher (`LICENSE`/`CONTRIBUTING`) のみであり、機械的な組織
  denylist は正当な所有権表記を誤検出してしまう。
- 先送りの理由: 利用者組織の識別子集合は本リポジトリからは判明せず、
  推測なしにここで安全に列挙できない。
- 意図する修正: 利用者組織の識別子集合が判明した時点で、それ用の
  スコープ付き denylist を追加する (publisher 自身の名前は除外)。
  それまで AGENTS.md ルールの非公開リポジトリ/インフラの半分は人手
  レビューに委ねる。
