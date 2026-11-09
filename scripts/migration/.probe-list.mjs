
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import CloudBase from '@cloudbase/manager-node';
const c = JSON.parse(readFileSync(path.join(homedir(), '.config/.cloudbase/auth.json'), 'utf8')).credential;
const app = new CloudBase({ secretId: c.tmpSecretId, secretKey: c.tmpSecretKey, token: c.tmpToken, envId: 'liwu-cny1313-d1gb2fukyb7cb19bb' });
const st = app.storage;
for (const prefix of ['xiai/', 'xiai/originals/', '']) {
  try {
    const r = await st.walkCloudDir(prefix, '');
    const arr = Array.isArray(r) ? r : (r && (r.Contents || r.objects || r.data)) || r;
    console.log('PREFIX', JSON.stringify(prefix), 'type=', typeof r, 'isArray=', Array.isArray(r), 'len=', Array.isArray(arr) ? arr.length : JSON.stringify(arr).slice(0,300));
    if (Array.isArray(arr) && arr.length) console.log('  sample:', JSON.stringify(arr.slice(0,3)).slice(0,500));
  } catch (e) { console.log('PREFIX', JSON.stringify(prefix), 'ERR', String(e && e.message || e).slice(0,300)); }
}
