/**
 * Convenience re-exports for email-related modules.
 *
 * This keeps the core surface area stable while allowing internal files
 * to stay split by responsibility.
 */

export * from './gmail-mcp';
export * from './gmail-types';
export * from './pm-email-loop';
export * from './pm-email-types';
export * from './introspection-email-loop';
export * from './introspection-email-types';
