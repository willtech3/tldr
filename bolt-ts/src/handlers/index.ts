/**
 * Handler registration module.
 *
 * Exports all event and interaction handlers for the Bolt app.
 *
 * Note: registerAssistantHandlers uses the Bolt.js Assistant class which
 * handles assistant_thread_started, assistant_thread_context_changed, and
 * message.im events in a unified way. The separate message handler has been
 * merged into the Assistant middleware.
 */

export { registerAssistantHandlers } from './assistant';
export { registerStyleHandlers } from './style';
export { registerActionHandlers } from './actions';
