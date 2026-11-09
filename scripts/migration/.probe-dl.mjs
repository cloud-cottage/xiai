
import { readFileSync, statSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import cloudbase from '@cloudbase/node-sdk';
const c = JSON.parse(readFileSync(path.join(homedir(), '.config/.cloudbase/auth.json'), 'utf8')).credential;
const envId = 'liwu-cny1313-d1gb2fukyb7cb19bb';
const app = cloudbase.init({ env: envId, secretId: c.tmpSecretId, secretKey: c.tmpSecretKey, sessionToken: c.tmpToken });
const key = 'xiai/images/02/02ff06284b657484c79de59d0f4eefc0315ec8c0d45f4693c5b05cb0dc961c10.webp';
const tmp = path.join('/var/folders/19/cqv1pr9n7tq5_75h0tgp7pqr0000gn/T/hermes_kernel_s1m826b3', 'probe-dl.bin');
try {
  const r = await app.downloadFile({ fileID: `${envId}/${key}`, tempFilePath: tmp });
  console.log('downloadFile ok keys=', Object.keys(r || {}), 'size=', statSync(tmp).size, 'msg=', r && r.message);
} catch (e) { console.log('downloadFile ERR', String(e && e.message || e).slice(0,300)); }
try {
  const u = await app.getTempFileURL({ fileList: [`${envId}/${key}`] });
  console.log('getTempFileURL:', JSON.stringify(u).slice(0,400));
  const url = u && u.fileList && u.fileList[0] && u.fileList[0].tempFileURL;
  if (url) {
    const res = await fetch(url);
    const buf = Buffer.from(await res.arrayBuffer());
    console.log('fetch signed url status=', res.status, 'bytes=', buf.length);
  }
} catch (e) { console.log('tempurl ERR', String(e && e.message || e).slice(0,300)); }
rmSync(tmp, { force: true });
