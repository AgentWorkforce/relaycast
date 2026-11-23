import { describe, expect, it } from 'vitest';
import { socketTarget } from '../ws.js';

describe('socketTarget', () => {
  const grant = 'wss://actors.example.com/v1/socket?key=grant-key&x=1';

  it('dials the grant as given without a socket origin', () => {
    expect(socketTarget(grant, undefined)).toEqual({ url: grant });
  });

  it('dials the grant path and query at an in-cluster http origin, keeping the public Host', () => {
    expect(socketTarget(grant, 'http://agent-relay-durable-actors.agent-relay.svc:7100')).toEqual({
      url: 'ws://agent-relay-durable-actors.agent-relay.svc:7100/v1/socket?key=grant-key&x=1',
      headers: { host: 'actors.example.com' },
    });
  });

  it('uses wss and the grant host as TLS server name for an https origin', () => {
    expect(socketTarget(grant, 'https://10.0.0.5:7443')).toEqual({
      url: 'wss://10.0.0.5:7443/v1/socket?key=grant-key&x=1',
      headers: { host: 'actors.example.com' },
      servername: 'actors.example.com',
    });
  });
});
