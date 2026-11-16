import { describe, expect, it } from 'vitest';
import { htmlToText } from './html.js';

describe('html', () => {
  it('scripts/styles stripped, whitespace collapsed', () => {
    const html = `<!doctype html><html><head><title>T</title><style>body{color:red}</style>
      <script>alert("x")</script><script type="module">import x from 'y'</script></head>
      <body>  <h1>Hello</h1>\n\n<p>one   two\tthree</p><noscript>enable js</noscript><!-- secret comment -->
      <template><p>tpl</p></template><svg><text>svg</text></svg><p>four</p></body></html>`;
    const t = htmlToText(html);
    expect(t).not.toMatch(/alert|color:red|import x|secret comment|enable js|tpl|svg/);
    expect(t).toContain('Hello');
    expect(t).toContain('one two three');
    expect(t).not.toMatch(/ {2}|\t/);
    expect(t.split('\n').every((l) => l.trim() === l && l.length > 0)).toBe(true);
  });

  it('decodes entities and keeps block boundaries as line breaks', () => {
    const t = htmlToText('<p>a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39; &#x41; &nbsp;f</p><div>g</div><br>h<li>i</li>');
    expect(t).toBe('a & b <c> "d" \'e\' A f\ng\nh\ni');
  });

  it('unterminated script and odd markup do not hang or leak', () => {
    expect(htmlToText('<p>ok</p><script>never closed')).toBe('ok');
    expect(htmlToText('<<p>>x</p')).toContain('x');
    expect(htmlToText('&#0; &#xFFFFFFF; &bogus;')).toBe('� � &bogus;');
  });

  it.each([
    ['<a', '<a'],
    ['<script', '<script'],
    ['<p x="', '<p x="'],
    ['<!--', '<!--'],
    ['&a', '&aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
    ['<script>', '<script></scrip'],
    ['<', '<<'],
  ])('linear on ~2 MiB of hostile %s input (< 200 ms)', (_label, unit) => {
    const html = unit.repeat(Math.ceil((2 * 1024 * 1024) / unit.length));
    const t0 = performance.now();
    htmlToText(html);
    expect(performance.now() - t0).toBeLessThan(200);
  });
});
