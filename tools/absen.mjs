#!/usr/bin/env node
/**
 * Generator absen — nulis satu baris ke absen.txt per commit, dengan tanggal
 * commit yang di-backdate persis sama dengan timestamp di barisnya.
 *
 * Dipakai dua cara:
 *   1. Nambal lubang lama  : node tools/absen.mjs --from=2025-10-23 --to=2026-08-14
 *   2. Harian (via Actions): node tools/absen.mjs          (default: 7 hari terakhir)
 *
 * Keputusan "hari ini absen atau libur" ditentukan oleh RNG yang di-seed dari
 * string tanggalnya. Jadi hasilnya deterministik: hari yang di-roll "libur"
 * akan selalu libur, dan hari yang di-roll "absen" tapi kelewat (Actions
 * gagal / GitHub down) bakal keisi otomatis pas run berikutnya. Ini yang bikin
 * dia self-healing tanpa perlu disentuh.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(REPO, 'absen.txt');

// Zona waktu yang dipakai di seluruh riwayat repo ini (WITA, tanpa DST).
const TZ = '+0800';      // dipakai di baris absen.txt (format lama dipertahankan)
const TZ_ISO = '+08:00'; // dipakai buat git, yang mau ISO-8601 ketat
const TZ_MIN = 8 * 60;

// Identitas commit. HARUS email yang terverifikasi di akun GitHub, kalau tidak
// commitnya nggak dihitung di contribution graph.
const NAME = process.env.ABSEN_NAME || 'Gianne Angely';
const EMAIL = process.env.ABSEN_EMAIL || '4n93ly22@gmail.com';

// Jam kerja: commit hanya muncul antara 09:00 dan 22:59 waktu lokal.
const HOUR_MIN = 9;
const HOUR_MAX = 22;

// Semua angka di bawah diukur dari periode sehat repo ini (2024-05-05 s/d
// 2025-10-22), bukan dikira-kira. Polanya ternyata tegas:
//
//   hari kerja : 383/383 hari terisi (100%), 1-8 commit, sebaran rata
//   weekend    : 119/153 hari terisi (77,8%), maksimal 3 commit
//
// Dua angka itu yang bikin porsi commit weekend jatuh di 12,6%.
const P_ACTIVE_WEEKDAY = 1.0;
const P_ACTIVE_WEEKEND = 0.778;

// Bobot jumlah commit per hari-aktif (index 0 = 1 commit, dst), langsung dari
// histogram periode acuan. Outlier 9/10/18 commit sengaja dibuang — itu artefak
// hari batch lama dijalankan, bukan pola beneran.
const WEIGHTS_WEEKDAY = [44, 52, 44, 41, 50, 46, 54, 48]; // 1..8 commit
const WEIGHTS_WEEKEND = [31, 41, 46];                     // 1..3 commit

const MESSAGES = [
  'Quick patch for something weird 😅',
  'Trying new approach... semoga bener 🙏',
  'Debugging session sukses ✅',
  'Improved logic (finally works lol) 😂',
  'Adding notes for tomorrow 📝',
  'Final commit for today 🌙',
  'Rapiin file & push bentar 🚀',
  'Fix minor issue before lunch 🍜',
  'Ngoding dikit pagi ini ☕',
  'Daily coding log 💻',
  'Update workflow — lebih efisien ⚙️',
  'Sedikit clean up before sleep 😴',
  'Learning day — AI stuff 🤖',
  'Minor tweak, major peace of mind 🌈',
  'Cuma iseng ngulik aja 🔍',
  'Weekend mode, but still coding 😎',
  'Tambah komentar biar gak bingung nanti 🧠',
  'Testing new feature idea 💡',
  'Refactor kecil biar rapi ✨',
  'Benerin bug misterius 😵',
];

// ---------------------------------------------------------------- RNG

/** FNV-1a — bikin seed integer dari string tanggal. */
function hashSeed(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 — PRNG kecil, deterministik dari seed. */
function rngFor(str) {
  let a = hashSeed(str);
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (rnd, arr) => arr[Math.floor(rnd() * arr.length)];
const between = (rnd, lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

function weightedIndex(rnd, weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rnd() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r < 0) return i;
  }
  return weights.length - 1;
}

// ---------------------------------------------------------------- tanggal

const dayOf = (s) => new Date(s + 'T00:00:00Z');
const isoOf = (d) => d.toISOString().slice(0, 10);

function addDays(iso, n) {
  const d = dayOf(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return isoOf(d);
}

/** Tanggal hari ini menurut waktu lokal TZ, bukan UTC. */
function todayLocal() {
  return new Date(Date.now() + TZ_MIN * 60_000).toISOString().slice(0, 10);
}

const isWeekend = (iso) => [0, 6].includes(dayOf(iso).getUTCDay());

// ---------------------------------------------------------------- git

const git = (args, env) =>
  execFileSync('git', args, {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...env },
  });

/** Set tanggal yang sudah punya commit, biar hari yang sudah terisi dilewati. */
function existingDates() {
  const out = git(['log', '--format=%ad', '--date=short']).trim();
  return new Set(out ? out.split('\n') : []);
}

/** Pertahankan CRLF/LF dan trailing-newline yang sudah dipakai file. */
function fileStyle() {
  if (!existsSync(FILE)) return { eol: '\r\n', text: '' };
  const text = readFileSync(FILE, 'utf8');
  return { eol: text.includes('\r\n') ? '\r\n' : '\n', text };
}

// ---------------------------------------------------------------- rencana

/** Jam-jam commit untuk satu hari. Sengaja TIDAK diurutkan, mengikuti pola lama. */
function planDay(iso) {
  const rnd = rngFor(iso);
  const weekend = isWeekend(iso);

  if (rnd() > (weekend ? P_ACTIVE_WEEKEND : P_ACTIVE_WEEKDAY)) return [];

  const n = weightedIndex(rnd, weekend ? WEIGHTS_WEEKEND : WEIGHTS_WEEKDAY) + 1;
  return Array.from({ length: n }, () => ({
    hh: between(rnd, HOUR_MIN, HOUR_MAX),
    mm: between(rnd, 0, 59),
    ss: between(rnd, 0, 59),
    msg: pick(rnd, MESSAGES),
  }));
}

const pad = (n) => String(n).padStart(2, '0');

// ---------------------------------------------------------------- main

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const dryRun = argv.includes('--dry-run');

// Default: lihat balik 7 hari sampai KEMARIN. Kenapa kemarin dan bukan hari
// ini — supaya jam 09:00-22:00 yang di-generate dijamin sudah lewat, berapa
// pun telatnya cron GitHub Actions jalan. Nggak ada commit bertanggal masa depan.
const to = arg('to', addDays(todayLocal(), -1));
const from = arg('from', addDays(to, -6));

if (from > to) {
  console.error(`Rentang tidak valid: from (${from}) > to (${to})`);
  process.exit(1);
}

const done = existingDates();
const style = fileStyle();

// Rapikan trailing newline sekali di awal, biar sisanya tinggal append.
if (style.text && !style.text.endsWith(style.eol)) {
  writeFileSync(FILE, style.text + style.eol, 'utf8');
}

const plan = [];
for (let d = from; d <= to; d = addDays(d, 1)) {
  if (done.has(d)) continue; // hari ini sudah ada commitnya, jangan ditumpuk
  for (const c of planDay(d)) plan.push({ date: d, ...c });
}

if (plan.length === 0) {
  console.log(`Tidak ada yang perlu diisi untuk ${from} .. ${to}.`);
  process.exit(0);
}

const days = new Set(plan.map((p) => p.date)).size;
console.log(`Rentang : ${from} .. ${to}`);
console.log(`Rencana : ${plan.length} commit tersebar di ${days} hari`);

if (dryRun) {
  for (const p of plan.slice(0, 15)) {
    console.log(`  ${p.date}T${pad(p.hh)}:${pad(p.mm)}:${pad(p.ss)} ${TZ} — ${p.msg}`);
  }
  if (plan.length > 15) console.log(`  ... (+${plan.length - 15} lagi)`);
  console.log('\n--dry-run: tidak ada yang di-commit.');
  process.exit(0);
}

let n = 0;
for (const p of plan) {
  const clock = `${pad(p.hh)}:${pad(p.mm)}:${pad(p.ss)}`;
  const line = `${p.date}T${clock} ${TZ} — ${p.msg}`;
  const gitDate = `${p.date}T${clock}${TZ_ISO}`;

  appendFileSync(FILE, line + style.eol, 'utf8');

  git(['add', '--', 'absen.txt']);
  git(['commit', '-m', p.msg], {
    // Author DAN committer date dua-duanya diset. Kalau cuma --date, committer
    // date-nya ikut jam sekarang dan riwayatnya langsung kelihatan janggal.
    GIT_AUTHOR_NAME: NAME,
    GIT_AUTHOR_EMAIL: EMAIL,
    GIT_AUTHOR_DATE: gitDate,
    GIT_COMMITTER_NAME: NAME,
    GIT_COMMITTER_EMAIL: EMAIL,
    GIT_COMMITTER_DATE: gitDate,
  });

  if (++n % 100 === 0) console.log(`  ... ${n}/${plan.length}`);
}

console.log(`Selesai: ${n} commit dibuat.`);
