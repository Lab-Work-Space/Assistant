import { describe, expect, it } from 'vitest';
import { PRAW_DEFAULT_MODEL } from '../company/seed.js';
import { PROMPTS_DIR, assembleSystem, loadPrompts } from './index.js';

const docs = loadPrompts(PROMPTS_DIR);
const praw = docs.get('heads/praw')!;

describe('praw prompt', () => {
  it('contains พี่, หนู, ค่ะ guidance, no-AI-self-introduction, concise-answer, use-tool-before-refusing and report-failures-truthfully rules', () => {
    for (const s of [
      'พี่', 'หนู', 'ค่ะ/ค้า/นะคะ', 'น้องสาว', 'ห้ามแนะนำตัวว่าเป็น', 'Claude', 'ผู้ช่วย AI',
      'ตอบสั้น กระชับ', 'ภาษาเดียวกับที่ผู้ใช้ถาม', 'อย่าตอบมั่ว',
      'ต้องเรียกใช้เครื่องมือนั้นก่อนตอบ', 'บอกผู้ใช้ตามจริงว่าทำไม่สำเร็จ', 'ห้ามบอกว่าทำสำเร็จถ้าเครื่องมือไม่ได้ทำสำเร็จจริง',
      'fenced code block',
    ]) expect(praw.body, s).toContain(s);
    expect(praw.body).not.toContain('LOCAL_LLM');
  });
  it('frontmatter dept praw, model gemini/…, color #F48FB1', () => {
    expect(praw.meta.name).toBe('พราว');
    expect(praw.meta.dept).toBe('praw');
    expect(praw.meta.model).toBe(`gemini/${PRAW_DEFAULT_MODEL}`);
    expect(praw.meta.color).toBe('#F48FB1');
    expect(praw.meta.tools).toEqual(['*']);
    expect(praw.meta.fragments).toEqual(['delegation', 'asking', 'approval-request', 'report-format']);
  });
  it('instructs title-less chat replies and slash-command answers for config requests', () => {
    expect(praw.body).toMatch(/respond.*type.*chat/s);
    expect(praw.body).toMatch(/no title/i);
    expect(praw.body).toContain('/budget set');
    expect(praw.body).toMatch(/never change|do not change/i);
    expect(praw.body).toMatch(/never claim/i);
  });
  it('assemble › system contains Core system docs, persona, fragments in order', () => {
    const system = ['charter', 'safety', 'tool-use', 'output', 'language'].map((s) => docs.get(`system/${s}`)!);
    const fragments = praw.meta.fragments.map((f) => docs.get(`fragments/${f}`)!);
    const out = assembleSystem({ actor: praw, system, fragments });
    const marks = [system[0]!.body, system[4]!.body, praw.body, ...fragments.map((f) => f.body)].map((b) => out.indexOf(b));
    expect(marks.every((i) => i >= 0)).toBe(true);
    expect([...marks].sort((a, b) => a - b)).toEqual(marks);
  });
});
