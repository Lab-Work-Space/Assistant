import { fakeResolver, fakeTransport } from '../../../tests/fakes/net.js';
import type { SearchHit } from '../web/webSearch.js';

export const PUBLIC = '93.184.215.14';
/** Socket-free net for watches: example.com / news.example resolve public, evil.example resolves private. */
export function watchNet(routes: Parameters<typeof fakeTransport>[0] = {}, extra: number[] = []) {
  const transport = fakeTransport(routes);
  const resolver = fakeResolver({ 'example.com': [PUBLIC], 'news.example': [PUBLIC], 'evil.example': ['10.1.2.3'] });
  return { transport, resolver, extraPorts: () => extra };
}
export const page = (...lines: string[]) => ({ body: `<html><body>${lines.map((l) => `<p>${l}</p>`).join('')}</body></html>` });
export const hit = (n: number): SearchHit => ({ title: `Result ${n}`, url: `https://news.example/r${n}`, snippet: 's' });
