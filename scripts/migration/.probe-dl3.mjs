
import { readFileSync, statSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import CloudBase from '@cloudbase/manager-node';
const c = JSON.parse(readFileSync(path.join(homedir(), '.config/.cloudbase/auth.json'), 'utf8')).credential;
const app = new CloudBase({ secretId: c.tmpSecretId, secretKey: c.tmpSecretKey, token: c.tmpToken, envId: 'liwu-cny1313-d1gb2fukyb7cb19bb' });
const key = 'xiai/images/02/02ff06284b657484c79de59d0f4eefc0315ec8c0d45f4693c5b05cb0dc961c10.webp';
const tmp = '/var/folders/19/cqv1pr9n7tq5_75h0tgp7pqr0000gn/T/hermes_kernel_s1m826b3/probe-dl3.bin';
try {
  const list = await app.storage.getTemporaryUrl([key]);
  console.log('getTemporaryUrl:', JSON.stringify(list).slice(0,300));
  const url = list[0].url;
  const res = await fetch(url);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(tmp, buf);
  const md5 = createHash('md5').update(buf).digest('hex');
  console.log('fetch status=', res.status, 'bytes=', buf.length, 'md5=', md5, 'expect md5=9d122c288d063761f123443d57f87771');
} catch (e) { console.log('ERR', String(e && e.message || e).slice(0,400)); }
rmSync(tmp, { force: true });
