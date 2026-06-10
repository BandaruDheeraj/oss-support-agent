import { renderMarkdownToHtml, wrapEmailHtml, markdownToPlainText } from './email-html';

describe('renderMarkdownToHtml', () => {
  it('renders headings with levels', () => {
    const html = renderMarkdownToHtml('# Title\n## Section\n### Sub');
    expect(html).toContain('<h1');
    expect(html).toContain('>Title</h1>');
    expect(html).toContain('>Section</h2>');
    expect(html).toContain('>Sub</h3>');
  });

  it('renders bold, inline code, and links', () => {
    const html = renderMarkdownToHtml('**bold** and `code` and [text](https://example.com)');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('>code</code>');
    expect(html).toContain('<a href="https://example.com"');
    expect(html).toContain('>text</a>');
  });

  it('autolinks bare URLs', () => {
    const html = renderMarkdownToHtml('See https://github.com/o/r/pull/1 for details');
    expect(html).toContain('<a href="https://github.com/o/r/pull/1"');
  });

  it('does not confuse numbers in prose with code-span placeholders', () => {
    const html = renderMarkdownToHtml('exhausted after 3 iterations with `applyPatch`');
    expect(html).toContain('after 3 iterations');
    expect(html).toContain('>applyPatch</code>');
  });

  it('renders fenced code blocks with escaping', () => {
    const html = renderMarkdownToHtml('```\nif (a < b) { run(); }\n```');
    expect(html).toContain('<pre');
    expect(html).toContain('if (a &lt; b) { run(); }');
  });

  it('renders dash lists as <ul>', () => {
    const html = renderMarkdownToHtml('- one\n- two');
    expect(html).toContain('<ul');
    expect(html).toContain('<li style');
    expect(html).toMatch(/>one<\/li>/);
    expect(html).toMatch(/>two<\/li>/);
  });

  it('renders horizontal rules', () => {
    expect(renderMarkdownToHtml('above\n\n---\n\nbelow')).toContain('<hr');
  });

  it('escapes raw HTML in input', () => {
    const html = renderMarkdownToHtml('<script>alert(1)</script>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('joins multi-line paragraphs with <br>', () => {
    const html = renderMarkdownToHtml('line one\nline two');
    expect(html).toContain('line one<br>line two');
  });
});

describe('wrapEmailHtml', () => {
  it('wraps fragment in a full document', () => {
    const doc = wrapEmailHtml('<p>hi</p>');
    expect(doc).toContain('<!DOCTYPE html>');
    expect(doc).toContain('<p>hi</p>');
    expect(doc).toContain('</html>');
  });
});

describe('markdownToPlainText', () => {
  it('strips markup but keeps content and link URLs', () => {
    const text = markdownToPlainText(
      '## Title\n**bold** `code` [text](https://example.com)\n```\nblock\n```'
    );
    expect(text).toContain('Title');
    expect(text).toContain('bold code text (https://example.com)');
    expect(text).toContain('block');
    expect(text).not.toContain('**');
    expect(text).not.toContain('```');
    expect(text).not.toContain('##');
  });
});
