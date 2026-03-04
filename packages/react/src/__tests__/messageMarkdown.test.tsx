import { fireEvent, render, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MessageMarkdown } from '../components/MessageMarkdown.js';

describe('MessageMarkdown', () => {
  it('renders markdown with soft line breaks and list items', () => {
    const { container } = render(
      <MessageMarkdown text={'**bold** line\nsecond line\n\n- one\n- two'} />,
    );

    const strong = container.querySelector('strong');
    expect(strong?.textContent).toBe('bold');
    expect(container.querySelectorAll('br')).toHaveLength(1);
    expect(Array.from(container.querySelectorAll('li')).map((node) => node.textContent)).toEqual([
      'one',
      'two',
    ]);
  });

  it('applies secure attributes to external links', () => {
    const { container } = render(
      <MessageMarkdown text={'[docs](https://example.com) and [local](/general)'} />,
    );

    const links = Array.from(container.querySelectorAll('a'));
    expect(links[0]?.getAttribute('href')).toBe('https://example.com');
    expect(links[0]?.getAttribute('target')).toBe('_blank');
    expect(links[0]?.getAttribute('rel')).toBe('noopener noreferrer nofollow');
    expect(links[1]?.getAttribute('href')).toBe('/general');
    expect(links[1]?.getAttribute('target')).toBeNull();
    expect(links[1]?.getAttribute('rel')).toBeNull();
  });

  it('renders highlighted fenced code and supports copy button', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    const { container, getByRole } = render(
      <MessageMarkdown
        text={'```ts\nconst answer: number = 42;\n```'}
        showCodeCopyButton
      />,
    );

    const code = container.querySelector('pre code');
    expect(code).not.toBeNull();
    expect(code?.querySelectorAll('span').length ?? 0).toBeGreaterThan(2);

    const copyButton = getByRole('button', { name: 'Copy code' });
    fireEvent.click(copyButton);

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('const answer: number = 42;');
      expect(copyButton.textContent).toBe('Copied');
    });
  });
});
