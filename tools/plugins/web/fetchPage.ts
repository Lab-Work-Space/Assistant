import { z } from 'zod';
import { redactText } from '../../../core/logger.js';
import { htmlToText } from '../../../net/html.js';
import { SafeFetchError } from '../../../net/guard.js';
import { urlKey } from '../../urls.js';
import { actorKey } from '../../../governance/budget.js';
import { sameActor, toolError, type ToolPlugin } from '../../types.js';
import { grantUrlCheck } from './grant-url.js';
import { readPage, type WebNetOptions } from './browser.js';

/** Characters of page text handed to the model. */
export const TEXT_MAX = 20_000;
const REASON_MAX = 300;
const TEXTUAL = /^(text\/[\w.+-]+|application\/(json|xml|xhtml\+xml|[\w.-]+\+(json|xml)))$/;

const Input = z.object({
  url: z
    .string()
    .min(1)
    .max(2048)
    .refine((u) => urlKey(u) !== null, 'must be an http(s) url')
    .describe('Absolute http(s) URL of the page to read'),
});

/**
 * Reads one public web page as text. Every hop goes through net/guard (P4). The result is raw text; the registry
 * wraps it untrusted and taints the run (PF11, P2). After taint, a url that neither the human typed in this run nor an
 * earlier web_search/fetch_page returned needs approval (R17/P5): an injected page cannot make the model send data out.
 */
export function fetchPageTool(o: WebNetOptions): ToolPlugin<{ url: string }> {
  return {
    name: 'fetch_page',
    description: 'Fetch a public web page (http/https) and return its readable text. Private, local and internal addresses are refused.',
    kind: 'read',
    untrustedOutput: true,
    untrustedSource: 'web',
    inputSchema: Input,
    /**
     * WEBGRANT-1 (D7): after untrusted content, a url not seen in this run may be covered by the task tree's live web grant. Consumed here,
     * before the approval decision; a covered url is added to `knownUrls` so the sync `requiresApproval` below lets it through. Every other
     * case returns null and the per-URL card follows (it never refuses and never throws: W-C13). The registry removes the port on the
     * approved path (W-C2), and a non-owner actor gets no consume, so the registry's own I1 refusal still applies (W-C1).
     */
    async precheck(input, ctx) {
      try {
        const key = urlKey(input.url);
        if (!ctx.tainted() || key === null || ctx.run.knownUrls.has(key) || !ctx.task || !ctx.webGrants) return null;
        if (!sameActor(ctx.task.owner, ctx.actor)) return null;
        const audit = (outcome: string) => ctx.audit({ actor: actorKey(ctx.actor), action: 'web_grant.consume', tool: 'fetch_page', taskId: ctx.task?.id ?? null, outcome });
        const g = grantUrlCheck(input.url);
        if (!g.ok) {
          ctx.run.webGrantMiss?.set(key, `url:${g.rule}`);
          await audit(`url:${g.rule}`);
          return null;
        }
        const r = await ctx.webGrants.consume({ rootId: ctx.task.rootId, host: g.host, chars: g.chars });
        if (r.ok) {
          ctx.run.knownUrls.add(key);
          await audit(`ok #${r.grantId} ${r.used}/${r.max}`);
        } else {
          ctx.run.webGrantMiss?.set(key, r.why);
          await audit(r.why);
        }
        return null;
      } catch {
        return null; // an audit or port fault: the call gets its card
      }
    },
    requiresApproval(input, ctx) {
      const key = urlKey(input.url);
      if (!ctx.tainted() || key === null || ctx.run.knownUrls.has(key)) return false;
      const miss = ctx.run.webGrantMiss?.get(key);
      const applied = miss === undefined ? '' : ` (web grant not applied: ${miss})`;
      return { reason: redactText(`fetch_page after untrusted content, url not seen in this run${applied}: ${key}`).slice(0, REASON_MAX) };
    },
    async run(input) {
      let res;
      try {
        res = await readPage(o, input.url);
      } catch (err) {
        if (err instanceof SafeFetchError) return toolError(`fetch_page ${err.code === 'blocked' ? 'refused' : 'failed'}: ${err.message}`);
        return toolError('fetch_page failed');
      }
      const encoding = (res.headers['content-encoding'] ?? 'identity').trim().toLowerCase();
      if (encoding !== '' && encoding !== 'identity') return toolError(`fetch_page: unsupported content encoding ${encoding.slice(0, 50)} at ${res.finalUrl}`);
      const type = res.contentType.split(';')[0]!.trim().toLowerCase();
      if (type && !TEXTUAL.test(type)) return toolError(`fetch_page: unsupported content type ${type.slice(0, 100)} at ${res.finalUrl}`);
      const raw = res.body.toString('utf8');
      const text = type === '' || type.includes('html') ? htmlToText(raw) : raw.trim();
      const cut = text.length > TEXT_MAX;
      const notes = [res.truncated ? 'body truncated at 2 MiB' : '', cut ? `text truncated at ${TEXT_MAX} characters` : ''].filter(Boolean);
      const head = [`url: ${res.finalUrl}`, `status: ${res.status}`, ...(notes.length ? [`note: ${notes.join('; ')}`] : [])].join('\n');
      const content = `${head}\n\n${cut ? text.slice(0, TEXT_MAX) : text}`;
      return res.status >= 400 ? { content, isError: true } : { content };
    },
  };
}
