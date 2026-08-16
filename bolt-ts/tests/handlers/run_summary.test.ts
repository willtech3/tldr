import { buildRateLimitMessage } from '../../src/handlers/run_summary';
import { RATE_LIMIT_MAX_PER_MINUTE } from '../../src/security';

describe('buildRateLimitMessage', () => {
  it('talks about requests (chat shares the budget), not just summaries', () => {
    const message = buildRateLimitMessage(2500);
    expect(message).toContain(`${RATE_LIMIT_MAX_PER_MINUTE} requests a minute`);
    expect(message).toContain('~3s');
  });

  it('never tells the user to wait zero seconds', () => {
    expect(buildRateLimitMessage(0)).toContain('~1s');
  });
});
