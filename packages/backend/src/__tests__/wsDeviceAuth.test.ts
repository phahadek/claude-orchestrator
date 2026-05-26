import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const serverSource = fs.readFileSync(
  path.join(__dirname, '..', 'server.ts'),
  'utf-8',
);

describe('server.ts — WS device auth', () => {
  it('imports validateWsToken from DeviceAuth', () => {
    expect(serverSource).toMatch(/validateWsToken/);
    expect(serverSource).toMatch(/from.*auth\/DeviceAuth/);
  });

  it('extracts token from WS URL query params', () => {
    expect(serverSource).toMatch(/url\.searchParams\.get\(['"]token['"]\)/);
  });

  it('closes connection with code 4001 when token is invalid and devices exist', () => {
    expect(serverSource).toMatch(/ws\.close\(4001/);
  });

  it('calls getActiveDeviceCount for bootstrap detection', () => {
    expect(serverSource).toMatch(/getActiveDeviceCount/);
  });

  it('validates device token in WS connection handler', () => {
    // The connection handler block contains both validateWsToken and ws.close(4001)
    const handlerStart = serverSource.indexOf("wss.on('connection'");
    const handlerSlice = serverSource.slice(handlerStart, handlerStart + 1000);
    expect(handlerSlice).toMatch(/validateWsToken/);
    expect(handlerSlice).toMatch(/ws\.close\(4001/);
  });

  it('sends initial state burst only after token is validated', () => {
    const handlerStart = serverSource.indexOf("wss.on('connection'");
    const handlerSlice = serverSource.slice(handlerStart, handlerStart + 1500);
    const validateOffset = handlerSlice.indexOf('validateWsToken');
    const burstOffset = handlerSlice.indexOf('sendInitialStateBurst');
    expect(validateOffset).toBeGreaterThan(-1);
    expect(burstOffset).toBeGreaterThan(-1);
    expect(validateOffset).toBeLessThan(burstOffset);
  });
});

describe('ws/types.ts — enrollment message types', () => {
  it('defines enrollment_request server message', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'ws', 'types.ts'),
      'utf-8',
    );
    expect(source).toMatch(/type: 'enrollment_request'/);
  });

  it('defines enrollment_approve client message', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'ws', 'types.ts'),
      'utf-8',
    );
    expect(source).toMatch(/type: 'enrollment_approve'/);
  });
});
