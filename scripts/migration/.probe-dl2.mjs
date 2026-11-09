
import { readFileSync, statSync, rmSync, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import CloudBase from '@cloudbase/manager-node';
const c = JSON.parse(readFileSync(path.join(homedir(), '.config/.cloudbase/auth.json'), 'utf8')).credential;
const app = new CloudBase({ secretId: c.tmpSecretId, secretKey: c.tmpSecretKey, token: c.tmpToken, envId: 'liwu-cny1313-d1gb2fukyb7cb19bb' });
const key = 'xiai/images/02/02ff06284b657484c79de59d0f4eefc0315ec8c0d45f4693c5b05cb0dc961c10.webp';
const tmp = '/var/folders/19/cqv1pr9n7tq5_75h0tgp7pqr0000gn/T/hermes_kernel_s1m826b3/probe-dl2.bin';
try {
  const r = await app.storage.downloadFile({ cloudPath: key, localPath: tmp });
  const h = createHash('md5').update(createReadStream(tmp)).digest('hex');
  console.log('downloadFile ok size=', statSync(tmp).size, 'md5=', h, 'resp=', JSON.stringify(r).slice(0,200));
} catch (e) { console.log('downloadFile ERR', String(e && e.message || e).slice(0,300)); }
try {
  const info = await app.storage.getFileInfo(key);
  console.log('getFileInfo:', JSON.stringify(info).slice(0,300));
} catch (e) { console.log('getFileInfo ERR', String(e && e.message || e).slice(0,300)); }
rmSync(tmp, { force: true });
