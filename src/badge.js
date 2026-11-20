// The two places POCP mentions itself to people who didn't install it: a README badge that
// `pocp init` offers once (opt-in, default no, printed for a person to paste, never written
// into a file), and one line at the end of verify's job summary.

export const POCP_REPO_URL = 'https://github.com/harriswekselblatt/pocp';
export const HOW_IT_WORKS_URL = `${POCP_REPO_URL}/blob/main/docs/HOW-IT-WORKS.md`;

// A static shields.io badge in shields' own default grey: no logo, no colour of its own. It says
// the repository uses POCP, not that anything passed: a static image can't know the status, and
// POCP exists to replace claims nobody checked.
export const BADGE_IMAGE = 'https://img.shields.io/badge/uses-POCP-lightgrey';
export const BADGE_MARKDOWN = `[![uses POCP](${BADGE_IMAGE})](${POCP_REPO_URL})`;
export const BADGE_QUESTION = 'Show a "uses POCP" badge in your README? (prints the markdown to paste; changes no file) [y/N] ';

// The last line of verify's job summary, which the `pocp` status links to.
export const SUMMARY_FOOTER = `Checked by POCP · [how this works](${HOW_IT_WORKS_URL})`;

/** The lines that hand the badge to a person. */
export function badgeLines() {
  return ['README badge (paste it next to your other badges):', `  ${BADGE_MARKDOWN}`];
}

/**
 * Whether `pocp init` may ask about the badge: only on a first setup (re-running init never
 * asks again), for a person at a terminal, outside CI, and not when --json or --badge is given.
 */
export function badgeInteractive({ json, flags, configCreated, stdin = process.stdin, stdout = process.stdout, env = process.env }) {
  return !json && !flags.badge && Boolean(configCreated) && Boolean(stdin.isTTY && stdout.isTTY) && !env.CI;
}

/**
 * Ask once whether to show the badge. Only "y" or "yes" is a yes: Enter, anything else or a
 * closed terminal is no. On yes, `say` prints the markdown. Returns whether it was printed.
 */
export async function offerBadge({ interactive, ask, say }) {
  if (!interactive) return false;
  let answer = '';
  try {
    answer = await ask(BADGE_QUESTION);
  } catch {
    return false;
  }
  if (!/^\s*y(es)?\s*$/i.test(String(answer))) return false;
  say(badgeLines().join('\n'));
  return true;
}
