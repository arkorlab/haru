# 既知の問題と先送りした作業

このファイルは、レビューで**発見した上で意図的に先送りした**
欠陥・負債を、再発見不要なように追跡するものです。運用者向けの
挙動上の制約は README の「既知の制約」に、こちらはコントリビューター
向けにファイル参照と修正方針を添えて記録します。

[English version](KNOWN_ISSUES.md)

規約: 各項目は「現状の挙動 / 先送りの理由 / 意図する修正」を書き、
修正されたら項目ごと削除します。

## 先送り (レビュー後のバックログ)

### defaultExec は spawn 失敗と timeout kill を exit 1 に潰す

- 場所: `packages/protocol/src/exec.ts`。
- 現状: バイナリ不在 (ENOENT) や `timeoutMs` による kill が
  `{code: 1, stdout: "", stderr: ""}` に解決され、呼び出し側
  (verify_gpu、sky ラッパー) は「なぜか」が消えた空 stderr の
  "exited 1" を報告する。
- 先送りの理由: 既存挙動を忠実に hoist したもの。結果の形を変えると
  全 exec 消費側のエラーマッピングに波及する。
- 意図する修正: `ExecResult` に execFile エラー由来の
  `signal`/`errorMessage` を追加し、SkyCliError / gpu エラー文字列に
  含める。

### chat スナップショットキャッシュにサイズ上限がない

- 場所: `services/haru-server/src/app.ts` (`snapshotCache`。加えて
  同じ寿命を共有する `fleetIdByReference` / `forgottenGenerations`
  マップ)。
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
- 現状: ターゲットの学習を停止した後、`switch_active` 前に失敗した
  promote (例: `probe_failed`) は、ターゲットの inference スロットを
  failed にして終了する。standby 姿勢 (vLLM sleep + 学習稼働) へ
  自動では戻らない。手動で `POST /v1/fleets/:id/demote` を叩けば
  復旧する。
- 先送りの理由: 自動復旧はそれ自体が小さなオペレーション (証明付き
  sleep + 学習開始) であり、失敗パスに直付けするとステップ機構の
  外で長い supervisor 呼び出しを走らせることになる。
- 意図する修正: 操作失敗後に対象への demote をキューする (既存の
  demote ステップを再利用)。それまでは運用手順書に記載。

### Postgres テストレーンはテストごとにマイグレーションを再実行する

- 場所: `packages/db/src/testing/index.ts`
  (`createPostgresTestDatabase`)。
- 現状: 各テストが DB を作成してコミット済みマイグレーション一式を
  再実行する。PGlite レーンには migrate-once 最適化を入れたが CI
  レーンには未適用。
- 先送りの理由: マイグレーションは現在単一ファイルに squash 済みで、
  テストあたりのコストは小さい。
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
