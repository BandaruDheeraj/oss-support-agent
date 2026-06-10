/**
 * Markdown → HTML rendering for outbound email.
 *
 * Our email bodies are generated Markdown using a constrained subset:
 * #/##/### headings, **bold**, `inline code`, ``` fences, "- " lists,
 * [text](url) links, bare URLs, --- rules, and paragraphs. This renders
 * that subset with inline styles (email clients ignore <style> blocks)
 * so every email is readable in any client. All text is HTML-escaped
 * before markup is applied.
 */

const STYLES = {
  body: "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;color:#1f2328;max-width:720px;margin:0 auto;padding:16px",
  h1: 'font-size:20px;margin:20px 0 8px;border-bottom:1px solid #d1d9e0;padding-bottom:6px',
  h2: 'font-size:17px;margin:18px 0 6px',
  h3: 'font-size:15px;margin:16px 0 4px',
  p: 'margin:8px 0',
  ul: 'margin:8px 0;padding-left:24px',
  li: 'margin:3px 0',
  pre: 'background:#f6f8fa;padding:12px;border-radius:6px;overflow-x:auto;font-size:13px;line-height:1.45;margin:8px 0',
  code: 'background:#f6f8fa;padding:1px 5px;border-radius:4px;font-size:92%;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
  hr: 'border:none;border-top:1px solid #d1d9e0;margin:20px 0',
  a: 'color:#0969da',
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Inline markup: code spans, bold, links, bare-URL autolinking. */
function renderInline(text: string): string {
  let s = escapeHtml(text);

  // Pull code spans out first so their contents are never styled/linked.
  // The \u0000 sentinel cannot occur in escaped text, so it is collision-free.
  const codes: string[] = [];
  s = s.replace(/`([^`]+)`/g, (_m, c: string) => {
    codes.push(c);
    return `\u0000${codes.length - 1}\u0000`;
  });

  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    `<a href="$2" style="${STYLES.a}">$1</a>`
  );
  // Autolink bare URLs that aren't already part of an <a> we just emitted.
  s = s.replace(
    /(^|[\s(])(https?:\/\/[^\s<)]+)/g,
    `$1<a href="$2" style="${STYLES.a}">$2</a>`
  );

  s = s.replace(
    /\u0000(\d+)\u0000/g,
    (_m, i: string) => `<code style="${STYLES.code}">${codes[Number(i)]}</code>`
  );
  return s;
}

/**
 * Render the constrained Markdown subset to an HTML fragment.
 */
export function renderMarkdownToHtml(md: string): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    if (/^```/.test(line)) {
      const block: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) {
        block.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      out.push(`<pre style="${STYLES.pre}"><code>${escapeHtml(block.join('\n'))}</code></pre>`);
      continue;
    }

    // Heading
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      const style = level === 1 ? STYLES.h1 : level === 2 ? STYLES.h2 : STYLES.h3;
      out.push(`<h${level} style="${style}">${renderInline(heading[2])}</h${level}>`);
      i++;
      continue;
    }

    // Horizontal rule
    if (/^---+\s*$/.test(line)) {
      out.push(`<hr style="${STYLES.hr}">`);
      i++;
      continue;
    }

    // List (consecutive "- " lines)
    if (/^\s*-\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*-\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*-\s+/, ''));
        i++;
      }
      out.push(
        `<ul style="${STYLES.ul}">` +
          items.map((it) => `<li style="${STYLES.li}">${renderInline(it)}</li>`).join('') +
          '</ul>'
      );
      continue;
    }

    // Blank line — paragraph separator
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Paragraph: consume consecutive non-blank, non-structural lines
    const para: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^(#{1,3}\s|```|---+\s*$|\s*-\s)/.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    out.push(`<p style="${STYLES.p}">${para.map(renderInline).join('<br>')}</p>`);
  }

  return out.join('\n');
}

/** Wrap a rendered fragment in a minimal email-safe shell. */
export function wrapEmailHtml(bodyHtml: string): string {
  return (
    '<!DOCTYPE html><html><body style="margin:0;padding:0;background:#ffffff">' +
    `<div style="${STYLES.body}">${bodyHtml}</div>` +
    '</body></html>'
  );
}

/**
 * Markdown → readable plain text, for the text/plain alternative part.
 * Keeps link URLs visible and strips markup characters.
 */
export function markdownToPlainText(md: string): string {
  return md
    .replace(/\r\n/g, '\n')
    .replace(/^```.*$/gm, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/^---+\s*$/gm, '——————————')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
