# 既知の問題と先送りした作業

このファイルは、レビューで**発見した上で意図的に先送りした**
欠陥・負債を、再発見不要なように追跡するものです。運用者向けの
挙動上の制約は README の「既知の制約」に、こちらはコントリビューター
向けにファイル参照と修正方針を添えて記録します。

[English version](KNOWN_ISSUES.md)

規約: 各項目は「現状の挙動 / 先送りの理由 / 意図する修正」を書き、
修正されたら項目ごと削除します。

## 先送り (レビュー後のバックログ)

### chat の TTFB 上限は undici の headersTimeout で暗黙に頭打ちになる

- 場所: `services/haru-server/src/chat-proxy.ts` (`fetchWithTimeout`
  経由)。README の `HARU_CHAT_HEADER_TIMEOUT_MS` 行にも注記あり。
- 現状: Node 組み込み fetch (undici) は独自の 300 秒 headersTimeout を
  持つ。それを超える TTFB 設定は 300 秒時点で TypeError ("fetch
  failed") となり、proxy は 504 ではなく 502 `upstream_unreachable`
  にマップしてしまう。
- 先送りの理由: 超えるにはカスタム undici dispatcher (依存追加) が
  必要。300 秒未満の設定 (デフォルト 30 秒) には影響なし。
- 意図する修正: 本当に >300 秒が必要になったら、chat proxy の fetch に
  `headersTimeout: 0` の dispatcher を注入し、undici の
  HeadersTimeoutError を明示的にマップする。

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

### chat スナップショットキャッシュのエントリは削除されない

- 場所: `services/haru-server/src/app.ts` (`snapshotCache`)。
- 現状: エントリは次アクセスで上書きされるが削除はされない。存在
  しなくなった (または参照されなくなった) フリートの最終
  FleetSnapshot がプロセス寿命の間残る。上限は「これまでに配信した
  フリート数」。
- 先送りの理由: このスライスではフリートは少数かつ長寿命で、フック
  すべき fleet 削除 API もまだない。
- 意図する修正: リクエスト時のポインタ lookup が null を返したら
  エントリを削除 + 小さな LRU 上限。

### キャッシュミス経路で fleet 行を二重取得している

- 場所: `services/haru-server/src/app.ts` (`cachedSnapshot`) が
  `getFleetRoutePointer` の後に `getFleetSnapshot` を呼ぶ箇所。
- 現状: ミス時に fleet 行を 2 回読む (narrow 1 回 + snapshot 内で
  full 1 回)。TTL ウィンドウごとフリートごとに余分な SELECT 1 回。
- 先送りの理由: ホットパス (ヒット) は既に最小で、ミスは TTL で
  有界。
- 意図する修正: 取得済み fleet 行を受け取る内部スナップショット
  ローダー。

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
