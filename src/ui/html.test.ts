import { expect, it } from 'bun:test';
import { renderHtml } from './html.ts';

it('should render stable, accessible static asset URLs', () => {
    const html = renderHtml();

    expect(renderHtml()).toBe(html);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('href="/assets/styles.css"');
    expect(html).toContain('src="/assets/app.js"');
    expect(html).not.toContain('?v=');
});
