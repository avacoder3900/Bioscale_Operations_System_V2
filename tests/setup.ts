import { beforeAll } from 'vitest';
import { login } from './helpers/auth';

beforeAll(async () => {
  await login();
}, 15000);
