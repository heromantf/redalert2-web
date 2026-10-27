// Which of the game folder's files the download ahead takes (predownload-worker.js):
// the game's data but the movies, or with them. Not taken: the movies unless
// asked (movies01.mix, movies02.mix, movmd03.mix: 1,007 of the folder's 1,993
// MB, read as they play, and they do not compress: spike/opfs/RESULT.md), and
// what the game never opens: the redistributables' installers (_CommonRedist),
// the manuals, the map editor (FinalAlert2). The rest is about 810 MB.
// files: [{ path, size, mtime }].
const MOVIES = /^(movies0[12]|movmd03)\.mix$/i;
const NOT_THE_GAME = /^(_CommonRedist|Manuals|FinalAlert2)\//i;

export const isMovie = (f) => MOVIES.test(f.path);
export const aheadFiles = (files, { movies = false } = {}) =>
  files.filter((f) => f.size > 0 && !NOT_THE_GAME.test(f.path) && (movies || !isMovie(f)));
export const movieFiles = (files) => files.filter((f) => f.size > 0 && isMovie(f));
// the manifest (web/server.mjs's /data/manifest.json) as such files
export async function manifestFiles(url = '/data/manifest.json') {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`manifest: HTTP ${r.status}`);
  return (await r.json()).files.filter((f) => !f.d).map((f) => ({ path: f.p, size: f.s, mtime: f.m }));
}
