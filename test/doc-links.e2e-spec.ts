import { markdownLinkDestinations, markdownOutsideCode } from '../scripts/verify-doc-links';

describe('documentation link parser', () => {
  it('ignores route notation inside inline code', () => {
    const markdown = '| 수업 | `/sessions/[sessionId]` + `/feedback/[studentId]` |';
    expect(markdownLinkDestinations(markdown)).toEqual([]);
  });

  it('ignores link-shaped examples inside fenced code blocks', () => {
    const markdown = [
      '```md',
      '[example](./not-a-real-file.md)',
      '```',
      '[real](./REAL.md)',
    ].join('\n');
    expect(markdownLinkDestinations(markdown)).toEqual(['./REAL.md']);
  });

  it('keeps headings and real links outside code', () => {
    const markdown = '# 제목\n\n`[route](+/new)`\n\n[문서](./DOC.md#제목)';
    expect(markdownOutsideCode(markdown)).toContain('# 제목');
    expect(markdownLinkDestinations(markdown)).toEqual(['./DOC.md#제목']);
  });
});
