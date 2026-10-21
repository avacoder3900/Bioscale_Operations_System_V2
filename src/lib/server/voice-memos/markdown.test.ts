import { describe, it, expect } from 'vitest';
import { renderDigestMarkdown } from './markdown';

describe('renderDigestMarkdown', () => {
	it('renders headings, lists, paragraphs, and inline markup', () => {
		const html = renderDigestMarkdown(
			['## Done', '- Re-fit **358** curves', '- Checked `SPU-0247`', '', 'Next: *magnet* sweep.', '1. one', '2. two'].join('\n')
		);
		expect(html).toContain('<h4 class="md-h2">Done</h4>');
		expect(html).toContain('<ul class="md-ul"><li>Re-fit <strong>358</strong> curves</li><li>Checked <code class="md-code">SPU-0247</code></li></ul>');
		expect(html).toContain('<p class="md-p">Next: <em>magnet</em> sweep.</p>');
		expect(html).toContain('<ol class="md-ol"><li>one</li><li>two</li></ol>');
	});

	it('links site paths and https, nothing else', () => {
		expect(renderDigestMarkdown('[TASK-184](/kanban/task/abc)')).toContain('<a href="/kanban/task/abc" class="md-link">TASK-184</a>');
		expect(renderDigestMarkdown('[doc](https://x.com/a)')).toContain('target="_blank"');
		expect(renderDigestMarkdown('[x](javascript:alert(1))')).not.toContain('<a');
		expect(renderDigestMarkdown('[x](//evil.com)')).not.toContain('<a');
	});

	it('escapes all HTML in the input', () => {
		const html = renderDigestMarkdown('<script>alert(1)</script> <img src=x onerror=alert(1)> [a"b](/p" onclick="x)');
		expect(html).not.toContain('<script');
		expect(html).not.toContain('<img');
		expect(html).not.toMatch(/onclick="/);
		expect(html).toContain('&lt;script&gt;');
	});

	it('leaves code spans literal', () => {
		expect(renderDigestMarkdown('`**not bold**`')).toContain('<code class="md-code">**not bold**</code>');
	});
});
