// リクエストボタンの数を GoatCounter から取ってきて、content/requests.json に保存する（GitHub Actions で1時間ごとに実行）
// 新しく増えた分は GITHUB_OUTPUT に書き出し、ワークフローがお知らせ（GitHubのIssue → メール）を作る。
import fs from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const FILE = path.join(ROOT, "content/requests.json");
const token = (process.env.GC_TOKEN || "").trim();
const site = JSON.parse(await fs.readFile(path.join(ROOT, "content/site.json"), "utf8"));
const code = String(site.goatcounter || "").trim();
const out = async (k, v) => { if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, `${k}<<__EOF__\n${v}\n__EOF__\n`); };

if (!token || !code) { console.log("GoatCounterのAPIキー（GC_TOKEN）がまだ設定されていないので、何もしません"); await out("changed", "no"); process.exit(0); }

const LABEL = { story: "ストーリー版も遊びたい", talk: "トーク版も遊びたい", illust: "イラストがもっと見たい" };
const api = async (q) => {
  const r = await fetch(`https://${code}.goatcounter.com/api/v0/stats/hits?${q}`, { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } });
  if (!r.ok) throw new Error(`GoatCounter API ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
};

// 全期間（リクエスト機能を作った日から今日まで）のヒットを、ページを送りながら全部集める
const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const counts = {};
let exclude = [];
for (let page = 0; page < 30; page++) {
  const q = new URLSearchParams({ start: "2026-11-20", end: today, limit: "100" });
  if (exclude.length) q.set("exclude_paths", exclude.join(","));
  const j = await api(q.toString());
  const hits = j.hits || [];
  for (const h of hits) {
    const m = String(h.path || "").match(/^request\/(story|talk|illust)\/(.+)$/);
    if (m) counts[h.path] = { type: m[1], title: m[2], count: Number(h.count) || 0 };
  }
  exclude.push(...hits.map((h) => h.path_id));
  if (!j.more || !hits.length) break;
}

let prev = { counts: {} };
try { prev = JSON.parse(await fs.readFile(FILE, "utf8")); } catch {}
const news = [];
for (const [p, c] of Object.entries(counts)) {
  const before = (prev.counts[p] && prev.counts[p].count) || 0;
  if (c.count > before) news.push(`- ${c.title}：${LABEL[c.type]}（+${c.count - before}、合計 ${c.count}）`);
}
const same = JSON.stringify(Object.entries(counts).sort()) === JSON.stringify(Object.entries(prev.counts || {}).sort());
if (same) { console.log("変化なし"); await out("changed", "no"); process.exit(0); }

await fs.writeFile(FILE, JSON.stringify({ updated: new Date().toISOString(), counts }, null, 2) + "\n");
console.log(`更新しました（新しいリクエスト ${news.length} 件）\n${news.join("\n")}`);
await out("changed", "yes");
await out("news", news.join("\n"));
