import {
  formatPlusReplyTo,
  parseRunIdFromAddress,
  encodeRunIdForLocalPart,
  buildReplyFromInbound,
  stripHtml,
  type ResendInboundEvent,
} from './resend-mail';

describe('resend-mail helpers', () => {
  describe('encodeRunIdForLocalPart', () => {
    it('lowercases and replaces non-safe chars', () => {
      expect(encodeRunIdForLocalPart('Acme/Widgets#42-Foo Bar')).toBe('acme-widgets-42-foo-bar');
    });
    it('strips leading/trailing dashes and truncates to 63 chars', () => {
      const long = 'a'.repeat(100);
      expect(encodeRunIdForLocalPart(long).length).toBe(63);
      expect(encodeRunIdForLocalPart('---abc---')).toBe('abc');
    });
  });

  describe('formatPlusReplyTo / parseRunIdFromAddress', () => {
    it('round-trips a runId', () => {
      const addr = formatPlusReplyTo('bot@inbound.example.com', 'acme/widgets#42');
      expect(addr).toBe('bot+acme-widgets-42@inbound.example.com');
      expect(parseRunIdFromAddress(addr)).toBe('acme-widgets-42');
    });

    it('handles "Name <addr>" wrapping', () => {
      expect(parseRunIdFromAddress('PM <bot+xyz@inbound.example.com>')).toBe('xyz');
    });

    it('returns null when address has no plus tag', () => {
      expect(parseRunIdFromAddress('bot@inbound.example.com')).toBeNull();
    });

    it('throws on invalid base address', () => {
      expect(() => formatPlusReplyTo('no-at-sign', 'x')).toThrow();
    });
  });

  describe('stripHtml', () => {
    it('extracts text from a basic HTML reply', () => {
      const html = '<html><body><p>Hello world</p><p>second &amp; line</p></body></html>';
      expect(stripHtml(html)).toBe('Hello world\n\nsecond & line');
    });
  });

  describe('buildReplyFromInbound', () => {
    const baseEvent: ResendInboundEvent = {
      type: 'email.received',
      created_at: '2026-05-07T15:00:00Z',
      data: {
        email_id: 'eid-1',
        created_at: '2026-05-07T15:00:01Z',
        from: 'PM <pm@example.com>',
        to: ['bot+acme-widgets@inbound.example.com'],
        message_id: '<m1@x>',
        subject: 'Re: [agent-fix] acme/widgets/#1: x',
      },
    };

    it('extracts runId from to-address and prefers text over html', () => {
      const out = buildReplyFromInbound(baseEvent, { text: 'approved', html: '<p>nope</p>' });
      expect(out).not.toBeNull();
      expect(out!.runId).toBe('acme-widgets');
      expect(out!.reply.body).toBe('approved');
      expect(out!.reply.from).toBe('PM <pm@example.com>');
    });

    it('falls back to html when text is missing', () => {
      const out = buildReplyFromInbound(baseEvent, { text: null, html: '<p>looks good</p>' });
      expect(out!.reply.body).toBe('looks good');
    });

    it('returns null when no recipient has a plus tag', () => {
      const evt: ResendInboundEvent = {
        ...baseEvent,
        data: { ...baseEvent.data, to: ['bot@inbound.example.com'] },
      };
      expect(buildReplyFromInbound(evt, { text: 'hi' })).toBeNull();
    });

    it('returns null for non email.received events', () => {
      const evt: ResendInboundEvent = { ...baseEvent, type: 'email.delivered' };
      expect(buildReplyFromInbound(evt, { text: 'hi' })).toBeNull();
    });
  });
});
