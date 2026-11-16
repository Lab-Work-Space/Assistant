/**
 * Plain-text view of an HTML page for the model. Not a parser: script, style and other non-content elements are
 * dropped with their contents, tags become spaces or line breaks, entities are decoded, whitespace is collapsed.
 * Links (href) are not kept: only visible text reaches the model.
 *
 * Linear time on hostile input (a fetched page is attacker-controlled and up to 2 MiB, and the fetch deadline cannot
 * interrupt synchronous work): one forward scan with indexOf, the next `>` cached, no unbounded backtracking regex.
 */

const DROP = new Set(['script', 'style', 'noscript', 'template', 'svg', 'math', 'head', 'iframe', 'object', 'canvas']);
const BLOCK = new Set([
  'p', 'div', 'br', 'li', 'ul', 'ol', 'tr', 'td', 'th', 'table', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section', 'article',
  'header', 'footer', 'nav', 'main', 'aside', 'blockquote', 'pre', 'hr', 'dd', 'dt', 'dl', 'form', 'figure', 'figcaption', 'title',
]);

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', copy: '©', reg: '®', trade: '™',
  laquo: '«', raquo: '»', middot: '·', bull: '•', deg: '°', euro: '€', times: '×',
};

const codePoint = (n: number): string => (n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '�');

/** Decodes numeric and the common named character references; unknown names are left as written. Bounded quantifiers only. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#[xX][0-9a-fA-F]{1,8}|#\d{1,8}|[a-zA-Z][a-zA-Z0-9]{0,31});/g, (m, e: string) => {
    if (e[0] === '#') return codePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return NAMED[e.toLowerCase()] ?? m;
  });
}

const NAME = /\/?([a-zA-Z][a-zA-Z0-9]{0,63})/y;

/** Index just past the closing `</tag ... >` at or after `from`, or -1. Each call only scans forward from `from`. */
function closeOf(html: string, tag: string, from: number): number {
  const re = new RegExp(`</${tag}[^>]{0,256}>`, 'gi');
  re.lastIndex = from;
  const m = re.exec(html);
  return m ? m.index + m[0].length : -1;
}

/** Splits HTML into text runs with tags replaced by ' ' (inline) or '\n' (block). Linear: every step moves `i` forward. */
function stripTags(html: string): string {
  const out: string[] = [];
  let i = 0;
  let gt = -2; // cached index of the next '>' at or after the current '<' (-1: none left)
  const nextGt = (from: number) => {
    if (gt !== -1 && gt < from) gt = html.indexOf('>', from);
    return gt;
  };
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      out.push(html.slice(i));
      break;
    }
    out.push(html.slice(i, lt));
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      if (end === -1) break; // an unterminated comment hides the rest
      out.push(' ');
      i = end + 3;
      continue;
    }
    const close = nextGt(lt + 1);
    if (close === -1) {
      out.push(html.slice(lt)); // no '>' anywhere after: the rest is text
      break;
    }
    NAME.lastIndex = lt + 1;
    const m = NAME.exec(html);
    const bang = html[lt + 1] === '!' || html[lt + 1] === '?';
    if (!m && !bang) {
      out.push('<'); // a stray '<' is text
      i = lt + 1;
      continue;
    }
    i = close + 1;
    if (bang) {
      out.push(' ');
      continue;
    }
    const name = m![1]!.toLowerCase();
    const closing = m![0]!.startsWith('/');
    if (!closing && DROP.has(name)) {
      const end = closeOf(html, name, i);
      if (end === -1) break; // an unterminated script swallows the rest (fail closed: nothing of it leaks)
      i = end;
      out.push(' ');
      continue;
    }
    out.push(BLOCK.has(name) ? '\n' : ' ');
  }
  return out.join('');
}

export function htmlToText(html: string): string {
  return decodeEntities(stripTags(html))
    .replace(/ /g, ' ')
    .split('\n')
    .map((l) => l.replace(/[ \t\f\v\r]+/g, ' ').trim())
    .filter((l) => l.length > 0)
    .join('\n');
}
