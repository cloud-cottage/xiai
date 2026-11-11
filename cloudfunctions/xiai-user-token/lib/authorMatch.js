'use strict'
/**
 * 玺爱 · **作者名归一匹配引擎（纯函数单点）** ＋ 两个 op 的载荷 / 回包键面真源
 * ============================================================================
 * 本文件是 §3.82（作者校验）的**唯一实现点**，被两处复用：
 *   · 公开只读 op `suggestAuthors`（`lib/sealCards.js::PUBLIC_OPS` 成员）；
 *   · 管理员 op `repairAuthorPersonId`（`lib/ops.js::ADMIN_OPS` 成员，薄委派落
 *     `lib/sealCards.js::repairAuthorPersonId`）。
 *
 * **本文件零 DB、零写点、零身份门**（纯函数 + 冻结键面常量）；读写一律由调用方经
 * `lib/ops.js`（`readRows` / `persist`）与 `lib/sealCards.js::readOrderedWindow` 完成。
 *
 * 硬口径（逐条，规范 §3.82.1 〜 §3.82.5）：
 *   ① **归一恰五步、定序**：去空白 → 去括号（含其包裹内容）→ 去朝代前缀 → 全角→半角
 *      → 简→繁；**归一形只用于比对与回包 `normalized`，绝不写回任何数据行**。
 *   ② **简→繁真源 ＝ 仓内逐字表**（下方 `S2T_GLYPH_SOURCE` / `S2T_GLYPH_TARGET`，
 *      **人工对照、与仓内真源 `src/utils/traditional.js::s2t` 同值、非第三方库**；
 *      云函数 require 不到前端 ESM 模块 ⇒ 按同一真源就地带一份逐字表，**不引任何 npm /
 *      OpenCC / 远端转换服务**；表未覆盖的字**原样保留**、不猜）。
 *   ③ **四道 ＋ 包含，分数封闭五值**：`name`=100 / `alias`=90 / `courtesy`=80 /
 *      `art`=70 / `contains`=50；**回填阈值 80**（只有 name / alias / courtesy 可回填）。
 *   ④ **`EDGE`（边款）不参与**：扫描谓词在调用侧（`kind='FACE'`），本文件不提供绕过面。
 *   ⑤ **候选恰 7 键、回包恰 4 键**；无命中 ⇒ `ok:true` ＋ `candidates:[]`（**不是错误**）。
 */

const { REASONS, deny } = require('./config.js')

/* ---------------------------------------------------------------------------
 * 冻结键面（**唯一真源**；`index.js` 的按 op 收窄透传与离线自检都引这里）
 * ------------------------------------------------------------------------- */

/** `suggestAuthors` 载荷封闭键面（**恰 3 键**）。 */
const SUGGEST_AUTHORS_ALLOWED_KEYS = Object.freeze(['face_id', 'name', 'limit'])
/** `suggestAuthors` 成功回包键面（**恰 4 键**，顺序即回包顺序）。 */
const SUGGEST_AUTHORS_SUCCESS_KEYS = Object.freeze(['ok', 'query', 'normalized', 'candidates'])
/** 候选元素封闭键面（**恰 7 键**）。 */
const AUTHOR_CANDIDATE_KEYS = Object.freeze([
  'person_id',
  'display_name',
  'dynasty',
  'matched_field',
  'matched_value',
  'score',
  'is_current'
])
/** `suggestAuthors` 的 `limit`：缺省 5、值域 1〜10（越界 ⇒ `INVALID_VALUE`，**不静默夹取**）。 */
const SUGGEST_AUTHORS_DEFAULT_LIMIT = 5
const SUGGEST_AUTHORS_MAX_LIMIT = 10

/** `repairAuthorPersonId` 载荷封闭键面（**恰 3 键**）。 */
const REPAIR_AUTHOR_PERSON_ID_ALLOWED_KEYS = Object.freeze(['dry_run', 'limit', 'cursor'])
/** `repairAuthorPersonId` 的 `limit`：缺省 200、值域 1〜500（与 `repairImageStorage` 同尺）。 */
const REPAIR_AUTHOR_PERSON_ID_DEFAULT_LIMIT = 200
const REPAIR_AUTHOR_PERSON_ID_MAX_LIMIT = 500
/**
 * `repairAuthorPersonId` **读数键面并集**（**按 op 收窄、存在性驱动透传** ⇒
 * `dry_run` 轮回恰 5 键 `scanned/eligible/matched/samples`、真写轮回恰 6 键
 * `scanned/eligible/matched/written/failed`；`index.js` 的透传引这里）。
 */
const REPAIR_AUTHOR_PERSON_ID_READOUT_KEYS = Object.freeze([
  'scanned',
  'eligible',
  'matched',
  'samples',
  'written',
  'failed'
])
/** `dry_run` 回包 `samples` 元素封闭键面（**恰 4 键**、最多 5 条）。 */
const REPAIR_AUTHOR_PERSON_ID_SAMPLE_KEYS = Object.freeze(['row_id', 'query', 'person_id', 'score'])
/** 回填记录 `author_match` 封闭键面（**恰 5 键**）。 */
const AUTHOR_MATCH_KEYS = Object.freeze(['field', 'score', 'query', 'normalized', 'at'])
/** 真写回包 `failed[]` 元素键面（**恰 2 键**；`reason` 只用既有冻结值）。 */
const REPAIR_AUTHOR_PERSON_ID_FAILED_KEYS = Object.freeze(['row_id', 'reason'])

/** 命中字段封闭五值（顺序即分数从高到低）。 */
const MATCHED_FIELDS = Object.freeze(['name', 'alias', 'courtesy', 'art', 'contains'])
/** 分数面（封闭五值；**不得新增、不得改值**）。 */
const FIELD_SCORES = Object.freeze({ name: 100, alias: 90, courtesy: 80, art: 70, contains: 50 })
/** 回填阈值（**只有 `score ≥ 80` 才可写 `author_person_id` / `author_match`**）。 */
const BACKFILL_MIN_SCORE = 80

/* ---------------------------------------------------------------------------
 * 简繁逐字表（**人工对照、与仓内真源 `src/utils/traditional.js::s2t` 同值、非第三方库**）
 * ---------------------------------------------------------------------------
 * 云函数运行时 require 不到前端 ESM 模块 `src/utils/traditional.js` ⇒ 把该文件的
 * `S2T_GLYPH_SOURCE` / `S2T_GLYPH_TARGET` **逐字**（一个码位未改）带到本文件作
 * **最小对照表**：只带 s2t **逐字层**、不带任何词组表、**不引任何三方依赖**
 * （OpenCC / npm 简繁包 / 远端转换服务一律禁止）。两个字符串按码位逐位对应，
 * 建表时先滤掉排版空白、再按**码位**切分（表内含 CJK 扩展区代理对字符）。
 */
const S2T_GLYPH_SOURCE = `
  㐷㐹㐽㑇㑈㑔㑩㓆㓥㓰㔉㖊㖞㘎㚯㛀㛟㛠㛣㛤㛿㟆㟜㟥㡎㤘㤽㥪㧏㧐㧑㧟㧰㨫㭎㭏㭣㭤㭴㱩㱮㲿㳔㳕㳠㳡㳢㳽㴋㶉㶶㶽㺍㻅㻏㻘䀥䁖䂵䃅䅉䅟䅪䇲䉤䌶䌷䌸䌹䌺䌻䌼䌽䌾䌿䍀䍁䍠䎬䏝䑽䓓䓕䓖䓨䗖䘛䘞䙊䙌䙓䜣䜤䜥䜧䜩
  䝙䞌䞍䞎䞐䟢䢀䢁䢂䥺䥽䥾䥿䦀䦁䦂䦃䦅䦆䦶䦷䩄䭪䯃䯄䯅䲝䲞䲟䲠䲡䲢䲣䴓䴔䴕䴖䴗䴘䴙䶮与专业丛东丝丢两严丧临为丽举么义乌乐乔习乡书买乱争亏亘亚产亩亲亵亸亿仅从仓仪们众优会伛伞伟传伡伣伤伥伦伧伪伫体
  佥侠侣侥侦侧侨侩侪侬侭俣俦俨俩俪俫俭债倾偬偻偾偿傤傥傧储傩儿兑兖兰关兴兹养兽冁内冈册写军农冯决况冻净凉减凑凛凤凫凭凯击凿刍刘则刚创删刬刭刹刽刾刿剀剂剐剑剥剧劝办务劢动励劲劳势勋勚匀匦匮区医华协
  单卖卢卧卫却卺厅厉压厌厍厐厕厢厣厦厨厩厮县叁叆叇双变叙叠号叽吓吕吗吨听启吴呐呒呓呕呖呗员呙呛呜咏咙咛咝咤响哑哒哓哔哕哙哜哝哟唇唛唝唠唡唢唤啧啬啭啮啯啰啴啸喷喽喾嗫嗳嘘嘤嘱噜嚣园囱围囵国图圆圣圹
  场坏块坚坜坝坞坟坠垄垅垆垒垦垩垫垭垯垱垲垴埘埙埚堑堕塆墙壮声壳壶壸处备够头夹夺奁奂奋奖奥妆妇妈妩妪妫姗姹娄娅娆娇娈娱娲娴婳婴婵婶媪媭嫒嫔嫱嬷孙学孪宝实宠审宪宫宽宾寝对寻导寿将尔尘尧尴层屃屉届属
  屡屦屿岁岂岖岗岘岚岛岭岽岿峃峄峡峣峤峥峦峰崂崃崄崭嵘嵚嵝巅巩巯币帅师帏帐帜带帧帮帱帻帼幂庄庆床庐庑库应庙庞废庼廪开异弃弑张弪弯弹强归彟彦彨彻径徕忆忏忧忾怀态怂怃怄怅怆怜总怼怿恋恳恸恹恺恻恼恽悦
  悫悬悭悮悯惊惧惨惩惫惬惭惮惯愠愤愦慑慭懑懒懔戆戋戗战戬戯户扑执扩扪扫扬扰抚抛抟抠抡抢护报担拟拢拣拥拦拧拨择挂挚挛挜挝挞挟挠挡挢挣挤挥挦捝捞损捡换捣掳掴掷掸掺掼揽揾揿搀搁搂搄搅携摄摅摇摈摊撄撑撵
  撷撸撺擜擞攒敌敚敛敩数斋斓斩断无旧时旷旸昙昵昼昽显晋晒晓晔晕晖暂暅暧机杀杂权杠条来杨杩极构枞枢枣枥枧枨枪枫枭柠柽栀栅标栈栉栊栋栌栎栏树栖样栾桠桡桢档桤桥桦桧桨桩桪梦梼梾梿检棁棂椁椝椟椠椢椤椫椭
  椮楼榄榅榇榈榉榝槚槛槟槠横樯樱橥橱橹橼檩欢欤欧歼殁殇残殒殓殚殡殴毂毕毙毡毵毶氇气氢氩氲汉汤汹沄沟没沣沤沥沦沧沨沩沪泞泪泶泷泸泺泻泼泽泾洁洒洼浃浅浆浇浈浉浊测浍济浏浐浑浒浓浔浕涚涛涝涞涟涠涡涢涣
  涤润涧涨涩渊渌渍渎渐渑渔渖渗温湾湿溁溃溅溆溇滗滚滞滟滠满滢滤滥滦滨滩滪潆潇潋潍潜潴澛澜濑濒灏灭灯灵灶灾灿炀炉炖炜炝点炽烁烂烃烛烦烧烨烩烫烬热焖焘煴爱爷牍牦牵牺犊状犷犸犹狈狝狞独狭狮狯狰狱狲猃猎
  猕猡猪猫猬献獭玑玙玚玛玮环现玱玺珐珑珰珲琎琏琐琼瑶瑷瑸璎瓒瓮瓯电画畅畴疖疗疟疠疡疬疭疮疯疱疴痈痉痒痖痨痪痫瘅瘆瘗瘘瘪瘫瘾瘿癞癣癫皑皱皲盏盐监盖盗盘眍眦眬睁睐睑瞆瞒瞩矫矶矾矿砀码砖砗砚砜砺砻砾础
  硁硕硖硗硙硚硵硷碍碛碜碱礼祃祎祢祯祷祸禀禄禅离秃秆秘积称秽秾稆税稣稳穑穞穷窃窍窎窑窜窝窥窦窭竖竞笃笋笔笕笺笼笾筚筛筜筝筹筼筿简箓箦箧箨箩箪箫篑篓篮篯篱簖籁籴类籼粜粝粤粪粮糁糇糍紧絷縆纟纠纡红纣
  纥约级纨纩纪纫纬纭纮纯纰纱纲纳纴纵纶纷纸纹纺纻纼纽纾线绀绁绂练组绅细织终绉绊绋绌绍绎经绐绑绒结绔绕绖绗绘给绚绛络绝绞统绠绡绢绣绤绥绦继绨绩绪绫绬续绮绯绰绱绲绳维绵绶绷绸绹绺绻综绽绾绿缀缁缂缃缄
  缅缆缇缈缉缊缋缌缍缎缏缐缑缒缓缔缕编缗缘缙缚缛缜缝缞缟缠缡缢缣缤缥缦缧缨缩缪缫缬缭缮缯缰缱缲缳缴缵罂网罗罚罢罴羁羟羡群翘翙翚耢耧耸耻聂聋职聍联聩聪肃肠肤肮肴肾肿胀胁胆胧胨胪胫胶脉脍脐脑脓脔脚脱
  脶脸腘腭腻腼腽腾膑臜舆舣舰舱舻艰艳艺节芈芗芜芦苁苇苈苋苌苍苎茎茏茑茔茕茧荆荙荚荛荜荝荞荟荠荣荤荥荦荧荨荩荪荬荭荮莅莱莲莳莴莶莸莹莺莼萚萝萤营萦萧萨葱蒀蒇蒉蒋蒌蒏蓝蓟蓠蓣蓥蓦蔂蔷蔹蔺蔼蕰蕲蕴薮藓
  蘖虏虑虚虬虮虱虽虾虿蚀蚁蚂蚃蚕蚝蚬蛊蛎蛏蛮蛰蛱蛲蛳蛴蜕蜗蝇蝈蝉蝎蝼蝾螀螨蟏衅衔补衬衮袄袆袜袭袯装裆裈裢裣裤裥褛褴襕见观觃规觅视觇览觉觊觋觌觍觎觏觐觑觞触觯訚詟誉誊讠计订讣认讥讦讧讨让讪讫讬训议
  讯记讱讲讳讴讵讶讷许讹论讻讼讽设访诀证诂诃评诅识诇诈诉诊诋诌词诎诏诐译诒诓诔试诖诗诘诙诚诛诜话诞诟诠诡询诣诤该详诧诨诩诪诫诬语诮误诰诱诲诳说诵诶请诸诹诺读诼诽课诿谀谁谂调谄谅谆谇谈谉谊谋谌谍谎
  谏谐谑谒谓谔谕谖谗谘谙谚谛谜谝谞谟谠谡谢谣谤谥谦谧谨谩谪谫谬谭谮谯谰谱谲谳谴谵谶豮贝贞负贠贡财责贤败账货质贩贪贫贬购贮贯贰贱贲贳贴贵贶贷贸费贺贻贼贽贾贿赀赁赂赃资赅赆赇赈赉赊赋赌赍赎赏赐赑赒赓
  赔赕赖赗赘赙赚赛赜赝赟赠赡赢赣赪赵赶趋趱趸跃跄跞践跶跷跸跹跻踌踪踬踯蹑蹒蹰蹿躏躜躯车轧轨轩轪轫转轭轮软轰轱轲轳轴轵轶轷轸轹轺轻轼载轾轿辀辁辂较辄辅辆辇辈辉辊辋辌辍辎辏辐辑辒输辔辕辖辗辘辙辚辞辩
  辫边辽达迁过迈运还这进远违连迟迩迳选逊递逦逻遗遥邓邝邬邮邹邺邻郏郐郑郓郦郧郸酂酝酦酱酽酾酿释銮錾钅钆钇钉钊钋钌钍钎钏钐钑钒钓钔钕钖钗钘钙钚钛钜钝钞钠钡钢钣钤钥钦钧钨钩钪钫钬钭钮钯钰钱钲钳钴钵钶
  钷钸钹钺钻钼钽钾钿铀铁铂铃铄铅铆铇铈铉铊铋铌铍铎铏铐铑铒铓铔铕铖铗铘铙铚铛铜铝铞铟铠铡铢铣铤铥铦铧铨铩铪铫铬铭铮铯铰铱铳铴铵银铷铸铹铺铻铼铽铿销锁锂锃锄锅锆锇锈锉锊锋锌锍锎锏锐锑锒锓锔锕锖锗锘
  错锚锛锜锝锞锟锠锡锢锣锤锥锦锧锨锩锪锫锬锭键锯锰锱锲锳锴锵锶锷锸锹锺锻锼锽锾锿镀镁镂镃镄镅镆镇镈镉镊镋镌镍镎镏镐镑镒镓镔镕镖镗镘镙镚镛镜镝镞镟镠镡镢镣镤镥镦镧镨镩镪镫镬镭镮镯镱镲镳镴镵镶长门闩
  闪闫闬闭问闯闰闱闳间闵闶闷闸闹闺闻闼闽闾闿阀阁阂阃阄阅阆阇阈阉阊阋阌阍阎阏阐阑阒阓阔阕阖阗阘阙阚阛队阳阴阵阶际陆陇陈陉陕陦陧陨险随隐隶隽难雇雏雠雳雾霁霉霡霭靓靔静靥鞑鞒鞯鞲韦韧韨韩韪韫韬韵页顶
  顷顸项顺顼顽顾顿颀颁颂颃预颅领颇颈颉颊颋颌颍颎颏颐频颒颓颔颕颖颗题颙颚颛颜额颞颟颠颡颢颣颤颥颦颧风飏飐飑飒飓飔飕飖飗飘飙飚飞飨餍饣饤饦饧饨饩饪饫饬饭饮饯饰饱饲饳饴饵饶饷饸饹饺饻饼饽饾饿馀馁馂馃
  馄馅馆馇馈馉馊馋馌馍馎馏馐馑馒馓馔馕驭驮驯驰驱驲驳驴驵驶驷驸驹驺驻驼驽驾驿骀骁骂骃骄骅骆骇骈骉骊骋验骍骎骏骐骑骒骓骔骕骖骗骘骙骚骛骜骝骞骟骠骡骢骣骤骥骦骧髅髋髌鬓鬶魇魉鱼鱽鱾鱿鲀鲁鲂鲃鲄鲅鲆鲇
  鲈鲉鲊鲋鲌鲍鲎鲏鲐鲑鲒鲓鲔鲕鲖鲗鲘鲙鲚鲛鲜鲝鲞鲟鲠鲡鲢鲣鲤鲥鲦鲧鲨鲩鲪鲫鲬鲭鲮鲯鲰鲱鲲鲳鲴鲵鲷鲸鲹鲺鲻鲼鲽鲾鲿鳀鳁鳂鳃鳄鳅鳆鳇鳈鳉鳊鳋鳌鳍鳎鳏鳐鳑鳒鳓鳔鳕鳖鳗鳘鳙鳚鳛鳜鳝鳞鳟鳠鳡鳢鳣鳤鸟鸠鸡鸢
  鸣鸤鸥鸦鸧鸨鸩鸪鸫鸬鸭鸮鸯鸰鸱鸲鸳鸴鸵鸶鸷鸸鸹鸺鸻鸼鸽鸾鸿鹀鹁鹂鹃鹄鹅鹆鹇鹈鹉鹊鹋鹌鹍鹎鹏鹐鹑鹒鹓鹔鹕鹖鹗鹘鹙鹚鹛鹜鹝鹞鹟鹠鹡鹢鹣鹤鹥鹦鹧鹨鹩鹪鹫鹬鹭鹮鹯鹰鹱鹲鹳鹴鹾麦麸麹麺黄黉黡黩黪黾鼋鼌鼍
  鼹齐齑齿龀龁龂龃龄龅龆龇龈龉龊龋龌龙龚龛龟鿎鿏鿒鿔𠀾𠆲𠆿𠇹𠉂𠉗𠋆𠚳𠛅𠛆𠛾𠡠𠮶𠯟𠯠𠰱𠰷𠱞𠲥𠴛𠴢𠵸𠵾𡋀𡋗𡋤𡍣𡒄𡝠𡞋𡞱𡠟𡥧𡭜𡭬𡳃𡳒𡶴𡸃𡺃𡺄𢋈𢗓𢘙𢘝𢘞𢙏𢙐𢙑𢙒𢙓𢛯𢠁𢢐𢧐𢫊𢫞𢫬𢬍𢬦𢭏𢽾𣃁𣆐𣈣𣍨𣍯𣍰𣎑𣏢𣐕
  𣐤𣑶𣒌𣓿𣔌𣗊𣗋𣗙𣘐𣘓𣘴𣘷𣚚𣞎𣨼𣭤𣯣𣱝𣲗𣲘𣳆𣶩𣶫𣶭𣷷𣸣𣺼𣺽𣽷𤆡𤆢𤇃𤇄𤇭𤇹𤈶𤈷𤊀𤊰𤋏𤎺𤎻𤙯𤝢𤞃𤞤𤠋𤦀𤩽𤳄𤶊𤶧𤻊𤽯𤾀𤿲𥁢𥅘𥅴𥅿𥆧𥇢𥎝𥐟𥐯𥐰𥐻𥞦𥧂𥩟𥩺𥫣𥬀𥬞𥬠𥭉𥮋𥮜𥮾𥱔𥹥𥺅𥺇𦈈𦈉𦈋𦈌𦈎𦈏𦈐𦈑𦈒𦈓𦈔𦈕𦈖
  𦈗𦈘𦈙𦈚𦈛𦈜𦈝𦈞𦈟𦈠𦈡𦍠𦛨𦝼𦟗𦨩𦰏𦰴𦶟𦶻𦻕𧉐𧉞𧌥𧏖𧏗𧑏𧒭𧜭𧝝𧝧𧮪𧳕𧹑𧹒𧹓𧹔𧹕𧹖𧹗𧿈𨀁𨀱𨁴𨂺𨄄𨅛𨅫𨅬𨉗𨐅𨐆𨐇𨐈𨐉𨐊𨑹𨟳𨠨𨡙𨡺𨤰𨰾𨰿𨱀𨱁𨱂𨱃𨱄𨱅𨱆𨱇𨱈𨱉𨱊𨱋𨱌𨱍𨱎𨱏𨱐𨱑𨱒𨱓𨱔𨱕𨱖𨷿𨸀𨸁𨸂𨸃𨸄𨸅𨸆𨸇
  𨸉𨸊𨸋𨸌𨸎𨸘𨸟𩏼𩏽𩏾𩏿𩐀𩓋𩖕𩖖𩖗𩙥𩙦𩙧𩙨𩙩𩙪𩙫𩙬𩙭𩙮𩙯𩙰𩟿𩠀𩠁𩠂𩠃𩠅𩠆𩠇𩠈𩠉𩠊𩠋𩠌𩠎𩠏𩠠𩡖𩧦𩧨𩧩𩧪𩧫𩧬𩧭𩧮𩧯𩧰𩧱𩧲𩧳𩧴𩧵𩧶𩧸𩧺𩧻𩧼𩧿𩨀𩨁𩨂𩨃𩨄𩨅𩨆𩨇𩨈𩨉𩨊𩨋𩨌𩨍𩨎𩨏𩨐𩩈𩬣𩬤𩭹𩯒𩰰𩲒𩴌𩽹𩽺𩽻𩽼𩽽
  𩽾𩽿𩾁𩾂𩾃𩾄𩾅𩾆𩾇𩾈𩾊𩾋𩾌𩾎𪉂𪉃𪉄𪉅𪉆𪉈𪉉𪉊𪉋𪉌𪉍𪉎𪉏𪉐𪉑𪉒𪉔𪉕𪎈𪎉𪎊𪎋𪎌𪑅𪔭𪚏𪚐𪜎𪞝𪟎𪟝𪠀𪠟𪠡𪠳𪠵𪠸𪠺𪠽𪡀𪡃𪡋𪡏𪡛𪡞𪡺𪢌𪢐𪢒𪢕𪢖𪢠𪢮𪢸𪣆𪣒𪣻𪤄𪤚𪥠𪥫𪥰𪥿𪧀𪧘𪨊𪨗𪨧𪨩𪨶𪨷𪨹𪩇𪩎𪩘𪩛𪩷𪩸𪪏𪪑𪪞𪪴
  𪪼𪫌𪫡𪫷𪫺𪬚𪬯𪭝𪭢𪭧𪭯𪭵𪭾𪮃𪮋𪮖𪮳𪮶𪯋𪰶𪱥𪱷𪲎𪲔𪲛𪲮𪳍𪳗𪴙𪵑𪵣𪵱𪶄𪶒𪶮𪷍𪷽𪸕𪸩𪹀𪹠𪹳𪹹𪺣𪺪𪺭𪺷𪺸𪺻𪺽𪻐𪻨𪻲𪻺𪼋𪼴𪽈𪽝𪽪𪽭𪽮𪽴𪽷𪾔𪾢𪾣𪾦𪾸𪿊𪿞𪿫𪿵𫀌𫀓𫀨𫀬𫀮𫁂𫁟𫁡𫁱𫁲𫁳𫁷𫁺𫂃𫂆𫂈𫂖𫂿𫃗𫄙𫄚𫄛𫄜𫄝
  𫄞𫄟𫄠𫄡𫄢𫄣𫄤𫄥𫄦𫄧𫄨𫄩𫄪𫄫𫄬𫄭𫄮𫄯𫄰𫄱𫄲𫄳𫄴𫄵𫄶𫄷𫄸𫄹𫅅𫅗𫅥𫅭𫅼𫆏𫆝𫆫𫇘𫇛𫇪𫇭𫇴𫇽𫈉𫈎𫈟𫈵𫉁𫉄𫊪𫊮𫊸𫊹𫊻𫋇𫋌𫋲𫋷𫋹𫋻𫌀𫌇𫌋𫌨𫌪𫌫𫌬𫌭𫌯𫍐𫍙𫍚𫍛𫍜𫍝𫍞𫍟𫍠𫍡𫍢𫍣𫍤𫍥𫍦𫍧𫍨𫍩𫍪𫍫𫍬𫍭𫍮𫍯𫍰𫍱𫍲𫍳
  𫍴𫍵𫍶𫍷𫍸𫍹𫍺𫍻𫍼𫍽𫍾𫍿𫎆𫎌𫎦𫎧𫎨𫎩𫎪𫎫𫎬𫎭𫎱𫎳𫎸𫎺𫏃𫏆𫏋𫏌𫏐𫏑𫏕𫏞𫏨𫐄𫐅𫐆𫐇𫐈𫐉𫐊𫐋𫐌𫐍𫐎𫐏𫐐𫐑𫐒𫐓𫐔𫐕𫐖𫐗𫐘𫐙𫐷𫑘𫑡𫑷𫓥𫓦𫓧𫓨𫓩𫓪𫓫𫓬𫓭𫓮𫓯𫓰𫓱𫓲𫓳𫓴𫓵𫓶𫓷𫓸𫓹𫓺𫓻𫓼𫓽𫓾𫓿𫔀𫔁𫔂𫔃𫔄𫔅𫔆𫔇
  𫔈𫔉𫔊𫔋𫔌𫔍𫔎𫔏𫔐𫔑𫔒𫔓𫔔𫔕𫔖𫔭𫔮𫔯𫔰𫔲𫔴𫔵𫔶𫔽𫕚𫕥𫕨𫖃𫖅𫖇𫖑𫖒𫖓𫖔𫖕𫖖𫖪𫖫𫖬𫖭𫖮𫖯𫖰𫖱𫖲𫖳𫖴𫖵𫖶𫖷𫖸𫖹𫖺𫗇𫗈𫗉𫗊𫗋𫗚𫗞𫗟𫗠𫗡𫗢𫗣𫗤𫗥𫗦𫗧𫗨𫗩𫗪𫗫𫗬𫗭𫗮𫗯𫗰𫗱𫗳𫗴𫗵𫘛𫘜𫘝𫘞𫘟𫘠𫘡𫘣𫘤𫘥𫘦𫘧𫘨𫘩
  𫘪𫘫𫘬𫘭𫘮𫘯𫘰𫘱𫘽𫙂𫚈𫚉𫚊𫚋𫚌𫚍𫚎𫚏𫚐𫚑𫚒𫚓𫚔𫚕𫚖𫚗𫚘𫚙𫚚𫚛𫚜𫚝𫚞𫚟𫚠𫚡𫚢𫚣𫚤𫚥𫚦𫚧𫚨𫚩𫚪𫚫𫚬𫚭𫛚𫛛𫛜𫛝𫛞𫛟𫛠𫛡𫛢𫛣𫛤𫛥𫛦𫛧𫛨𫛩𫛪𫛫𫛬𫛭𫛮𫛯𫛰𫛱𫛲𫛳𫛴𫛵𫛶𫛷𫛸𫛹𫛺𫛻𫛼𫛽𫛾𫜀𫜁𫜂𫜃𫜄𫜅𫜊𫜑𫜒𫜓𫜔
  𫜕𫜙𫜟𫜨𫜩𫜪𫜫𫜬𫜭𫜮𫜯𫜰𫜲𫜳𫝈𫝋𫝦𫝧𫝨𫝩𫝪𫝫𫝬𫝭𫝮𫝵𫞅𫞗𫞚𫞛𫞝𫞠𫞡𫞢𫞣𫞥𫞦𫞧𫞨𫞩𫞷𫟃𫟄𫟅𫟆𫟇𫟑𫟕𫟞𫟟𫟠𫟡𫟢𫟤𫟥𫟦𫟫𫟬𫟲𫟳𫟴𫟵𫟶𫟷𫟸𫟹𫟺𫟻𫟼𫟽𫟾𫟿𫠀𫠁𫠂𫠅𫠆𫠇𫠈𫠊𫠋𫠌𫠏𫠐𫠑𫠒𫠖𫠜𫢸𫧃𫧮𫫇𫬐𫭟𫭢𫭼
  𫮃𫰛𫵷𫶇𫷷𫸩𬀩𬀪𬂩𬃊𬇕𬇙𬇹𬉼𬊈𬊤𬍛𬍡𬍤𬒈𬒗𬕂𬘓𬘘𬘡𬘩𬘫𬘬𬘭𬘯𬙂𬙊𬙋𬜬𬜯𬞟𬟁𬟽𬣙𬣞𬣡𬣳𬤇𬤊𬤝𬨂𬨎𬩽𬪩𬬩𬬭𬬮𬬱𬬸𬬹𬬻𬬿𬭁𬭊𬭎𬭚𬭛𬭤𬭩𬭬𬭭𬭯𬭳𬭶𬭸𬭼𬮱𬮿𬯀𬯎𬱖𬱟𬳵𬳶𬳽𬳿𬴂𬴃𬴊𬶋𬶍𬶏𬶐𬶟𬶠𬶨𬶭𬶮𬷕𬸘𬸚
  𬸣𬸦𬸪𬸯𬹼𬺈𬺓𰬸𰰨𰶎𰾄𰾭𱊜
`
const S2T_GLYPH_TARGET = `
  傌㑶偑㑳倲㑯儸𠗣劏劃劚噚喎㘚㜄媰𡞵𡢃㜏孋𡠹㠏𡾱嵾幓㥮懤慺掆㩳撝擓擽㩜棡椲𣙎樢樫殰殨瀇濧灡澾濄𣾷瀰潚鸂燶煱獱璯𤫩𤪺䁻瞜碽磾稏穇𥢢筴籔䊷紬縳絅䋙䋚綐綵䋻䋹繿繸䍦䎱膞𦪙薵薳藭罃螮𧝞𧜗𧜵䙡襬訢鿁𧩙䜀讌
  貙𧵳䝼𧶧賰躎𨊰𨊸𨋢釾鏺䥱𨯅𨦫𨧜䥇鐯鐥钁䦛䦟靦𩞯𩣑騧䯀䱽𩶘鮣鰆鰌鰧䱷鳾鵁鴷鶄鶪鷉鸊龑與專業叢東絲丟兩嚴喪臨爲麗舉麼義烏樂喬習鄉書買亂爭虧亙亞產畝親褻嚲億僅從倉儀們衆優會傴傘偉傳俥俔傷倀倫傖僞佇體
  僉俠侶僥偵側僑儈儕儂儘俁儔儼倆儷倈儉債傾傯僂僨償儎儻儐儲儺兒兌兗蘭關興茲養獸囅內岡冊寫軍農馮決況凍淨涼減湊凜鳳鳧憑凱擊鑿芻劉則剛創刪剗剄剎劊㓨劌剴劑剮劍剝劇勸辦務勱動勵勁勞勢勳勩勻匭匱區醫華協
  單賣盧臥衛卻巹廳厲壓厭厙龎廁廂厴廈廚廄廝縣叄靉靆雙變敘疊號嘰嚇呂嗎噸聽啓吳吶嘸囈嘔嚦唄員咼嗆嗚詠嚨嚀噝吒響啞噠嘵嗶噦噲嚌噥喲脣嘜嗊嘮啢嗩喚嘖嗇囀齧嘓囉嘽嘯噴嘍嚳囁噯噓嚶囑嚕囂園囪圍圇國圖圓聖壙
  場壞塊堅壢壩塢墳墜壟壠壚壘墾堊墊埡墶壋塏堖塒壎堝塹墮壪牆壯聲殼壺壼處備夠頭夾奪奩奐奮獎奧妝婦媽嫵嫗嬀姍奼婁婭嬈嬌孌娛媧嫺嫿嬰嬋嬸媼嬃嬡嬪嬙嬤孫學孿寶實寵審憲宮寬賓寢對尋導壽將爾塵堯尷層屓屜屆屬
  屢屨嶼歲豈嶇崗峴嵐島嶺崬巋嶨嶧峽嶢嶠崢巒峯嶗崍嶮嶄嶸嶔嶁巔鞏巰幣帥師幃帳幟帶幀幫幬幘幗冪莊慶牀廬廡庫應廟龐廢廎廩開異棄弒張弳彎彈強歸彠彥彲徹徑徠憶懺憂愾懷態慫憮慪悵愴憐總懟懌戀懇慟懨愷惻惱惲悅
  愨懸慳悞憫驚懼慘懲憊愜慚憚慣慍憤憒懾憖懣懶懍戇戔戧戰戩戱戶撲執擴捫掃揚擾撫拋摶摳掄搶護報擔擬攏揀擁攔擰撥擇掛摯攣掗撾撻挾撓擋撟掙擠揮撏挩撈損撿換搗擄摑擲撣摻摜攬搵撳攙擱摟揯攪攜攝攄搖擯攤攖撐攆
  擷擼攛㩵擻攢敵敓斂斆數齋斕斬斷無舊時曠暘曇暱晝曨顯晉曬曉曄暈暉暫𣈶曖機殺雜權槓條來楊榪極構樅樞棗櫪梘棖槍楓梟檸檉梔柵標棧櫛櫳棟櫨櫟欄樹棲樣欒椏橈楨檔榿橋樺檜槳樁樳夢檮棶槤檢梲欞槨槼櫝槧槶欏樿橢
  槮樓欖榲櫬櫚櫸樧檟檻檳櫧橫檣櫻櫫櫥櫓櫞檁歡歟歐殲歿殤殘殞殮殫殯毆轂畢斃氈毿𣯶氌氣氫氬氳漢湯洶澐溝沒灃漚瀝淪滄渢潙滬濘淚澩瀧瀘濼瀉潑澤涇潔灑窪浹淺漿澆湞溮濁測澮濟瀏滻渾滸濃潯濜涗濤澇淶漣潿渦溳渙
  滌潤澗漲澀淵淥漬瀆漸澠漁瀋滲溫灣溼濚潰濺漵漊潷滾滯灩灄滿瀅濾濫灤濱灘澦瀠瀟瀲濰潛瀦瀂瀾瀨瀕灝滅燈靈竈災燦煬爐燉煒熗點熾爍爛烴燭煩燒燁燴燙燼熱燜燾熅愛爺牘犛牽犧犢狀獷獁猶狽獮獰獨狹獅獪猙獄猻獫獵
  獼玀豬貓蝟獻獺璣璵瑒瑪瑋環現瑲璽琺瓏璫琿璡璉瑣瓊瑤璦璸瓔瓚甕甌電畫暢疇癤療瘧癘瘍癧瘲瘡瘋皰痾癰痙癢瘂癆瘓癇癉瘮瘞瘻癟癱癮癭癩癬癲皚皺皸盞鹽監蓋盜盤瞘眥矓睜睞瞼瞶瞞矚矯磯礬礦碭碼磚硨硯碸礪礱礫礎
  硜碩硤磽磑礄磠礆礙磧磣鹼禮禡禕禰禎禱禍稟祿禪離禿稈祕積稱穢穠穭稅穌穩穡穭窮竊竅窵窯竄窩窺竇窶豎競篤筍筆筧箋籠籩篳篩簹箏籌篔篠簡籙簀篋籜籮簞簫簣簍籃籛籬籪籟糴類秈糶糲粵糞糧糝餱餈緊縶緪糹糾紆紅紂
  紇約級紈纊紀紉緯紜紘純紕紗綱納紝縱綸紛紙紋紡紵紖紐紓線紺紲紱練組紳細織終縐絆紼絀紹繹經紿綁絨結絝繞絰絎繪給絢絳絡絕絞統綆綃絹繡綌綏絛繼綈績緒綾緓續綺緋綽鞝緄繩維綿綬繃綢綯綹綣綜綻綰綠綴緇緙緗緘
  緬纜緹緲緝縕繢緦綞緞緶線緱縋緩締縷編緡緣縉縛縟縝縫縗縞纏縭縊縑繽縹縵縲纓縮繆繅纈繚繕繒繮繾繰繯繳纘罌網羅罰罷羆羈羥羨羣翹翽翬耮耬聳恥聶聾職聹聯聵聰肅腸膚骯餚腎腫脹脅膽朧腖臚脛膠脈膾臍腦膿臠腳脫
  腡臉膕齶膩靦膃騰臏臢輿艤艦艙艫艱豔藝節羋薌蕪蘆蓯葦藶莧萇蒼苧莖蘢蔦塋煢繭荊薘莢蕘蓽萴蕎薈薺榮葷滎犖熒蕁藎蓀蕒葒葤蒞萊蓮蒔萵薟蕕瑩鶯蓴蘀蘿螢營縈蕭薩蔥蒕蕆蕢蔣蔞醟藍薊蘺蕷鎣驀虆薔蘞藺藹薀蘄蘊藪蘚
  櫱虜慮虛虯蟣蝨雖蝦蠆蝕蟻螞蠁蠶蠔蜆蠱蠣蟶蠻蟄蛺蟯螄蠐蛻蝸蠅蟈蟬蠍螻蠑螿蟎蠨釁銜補襯袞襖褘襪襲襏裝襠褌褳襝褲襉褸襤襴見觀覎規覓視覘覽覺覬覡覿覥覦覯覲覷觴觸觶誾讋譽謄訁計訂訃認譏訐訌討讓訕訖託訓議
  訊記訒講諱謳詎訝訥許訛論訩訟諷設訪訣證詁訶評詛識詗詐訴診詆謅詞詘詔詖譯詒誆誄試詿詩詰詼誠誅詵話誕詬詮詭詢詣諍該詳詫諢詡譸誡誣語誚誤誥誘誨誑說誦誒請諸諏諾讀諑誹課諉諛誰諗調諂諒諄誶談讅誼謀諶諜謊
  諫諧謔謁謂諤諭諼讒諮諳諺諦謎諞諝謨讜謖謝謠謗諡謙謐謹謾謫譾謬譚譖譙讕譜譎讞譴譫讖豶貝貞負貟貢財責賢敗賬貨質販貪貧貶購貯貫貳賤賁貰貼貴貺貸貿費賀貽賊贄賈賄貲賃賂贓資賅贐賕賑賚賒賦賭齎贖賞賜贔賙賡
  賠賧賴賵贅賻賺賽賾贗贇贈贍贏贛赬趙趕趨趲躉躍蹌躒踐躂蹺蹕躚躋躊蹤躓躑躡蹣躕躥躪躦軀車軋軌軒軑軔轉軛輪軟轟軲軻轤軸軹軼軤軫轢軺輕軾載輊轎輈輇輅較輒輔輛輦輩輝輥輞輬輟輜輳輻輯轀輸轡轅轄輾轆轍轔辭辯
  辮邊遼達遷過邁運還這進遠違連遲邇逕選遜遞邐邏遺遙鄧鄺鄔郵鄒鄴鄰郟鄶鄭鄆酈鄖鄲酇醞醱醬釅釃釀釋鑾鏨釒釓釔釘釗釙釕釷釺釧釤鈒釩釣鍆釹鍚釵鈃鈣鈈鈦鉅鈍鈔鈉鋇鋼鈑鈐鑰欽鈞鎢鉤鈧鈁鈥鈄鈕鈀鈺錢鉦鉗鈷鉢鈳
  鉕鈽鈸鉞鑽鉬鉭鉀鈿鈾鐵鉑鈴鑠鉛鉚鉋鈰鉉鉈鉍鈮鈹鐸鉶銬銠鉺鋩錏銪鋮鋏鋣鐃銍鐺銅鋁銱銦鎧鍘銖銑鋌銩銛鏵銓鎩鉿銚鉻銘錚銫鉸銥銃鐋銨銀銣鑄鐒鋪鋙錸鋱鏗銷鎖鋰鋥鋤鍋鋯鋨鏽銼鋝鋒鋅鋶鐦鐧銳銻鋃鋟鋦錒錆鍺鍩
  錯錨錛錡鍀錁錕錩錫錮鑼錘錐錦鑕鍁錈鍃錇錟錠鍵鋸錳錙鍥鍈鍇鏘鍶鍔鍤鍬鍾鍛鎪鍠鍰鎄鍍鎂鏤鎡鐨鎇鏌鎮鎛鎘鑷钂鐫鎳鎿鎦鎬鎊鎰鎵鑌鎔鏢鏜鏝鏍鏰鏞鏡鏑鏃鏇鏐鐔钁鐐鏷鑥鐓鑭鐠鑹鏹鐙鑊鐳鐶鐲鐿鑔鑣鑞鑱鑲長門閂
  閃閆閈閉問闖閏闈閎間閔閌悶閘鬧閨聞闥閩閭闓閥閣閡閫鬮閱閬闍閾閹閶鬩閿閽閻閼闡闌闃闠闊闋闔闐闒闕闞闤隊陽陰陣階際陸隴陳陘陝隯隉隕險隨隱隸雋難僱雛讎靂霧霽黴霢靄靚靝靜靨韃鞽韉韝韋韌韍韓韙韞韜韻頁頂
  頃頇項順頊頑顧頓頎頒頌頏預顱領頗頸頡頰頲頜潁熲頦頤頻頮頹頷頴穎顆題顒顎顓顏額顳顢顛顙顥纇顫顬顰顴風颺颭颮颯颶颸颼颻飀飄飆飈飛饗饜飠飣飥餳飩餼飪飫飭飯飲餞飾飽飼飿飴餌饒餉餄餎餃餏餅餑餖餓餘餒餕餜
  餛餡館餷饋餶餿饞饁饃餺餾饈饉饅饊饌饢馭馱馴馳驅馹駁驢駔駛駟駙駒騶駐駝駑駕驛駘驍罵駰驕驊駱駭駢驫驪騁驗騂駸駿騏騎騍騅騌驌驂騙騭騤騷騖驁騮騫騸驃騾驄驏驟驥驦驤髏髖髕鬢鬹魘魎魚魛魢魷魨魯魴䰾魺鮁鮃鮎
  鱸鮋鮓鮒鮊鮑鱟鮍鮐鮭鮚鮳鮪鮞鮦鰂鮜鱠鱭鮫鮮鮺鯗鱘鯁鱺鰱鰹鯉鰣鰷鯀鯊鯇鮶鯽鯒鯖鯪鯕鯫鯡鯤鯧鯝鯢鯛鯨鰺鯴鯔鱝鰈鰏鱨鯷鰮鰃鰓鱷鰍鰒鰉鰁鱂鯿鰠鰲鰭鰨鰥鰩鰟鰜鰳鰾鱈鱉鰻鰵鱅䲁鰼鱖鱔鱗鱒鱯鱤鱧鱣䲘鳥鳩雞鳶
  鳴鳲鷗鴉鶬鴇鴆鴣鶇鸕鴨鴞鴦鴒鴟鴝鴛鷽鴕鷥鷙鴯鴰鵂鴴鵃鴿鸞鴻鵐鵓鸝鵑鵠鵝鵒鷳鵜鵡鵲鶓鵪鵾鵯鵬鵮鶉鶊鵷鷫鶘鶡鶚鶻鶖鷀鶥鶩鷊鷂鶲鶹鶺鷁鶼鶴鷖鸚鷓鷚鷯鷦鷲鷸鷺䴉鸇鷹鸌鸏鸛鸘鹺麥麩麴麪黃黌黶黷黲黽黿鼂鼉
  鼴齊齏齒齔齕齗齟齡齙齠齜齦齬齪齲齷龍龔龕龜䃮䥑鿓鎶𠁞儣𠌥俓㒓𠏢儭𠠎剾𠞆𪟖勑嗰哯噅㘉嚧囃𡅏𡃕𡄔𡄣㗲𡓾𡑭壗𡔖壈㜷㜗㜢孎孻𡮉𡮣𡳳𦘧嵼𡽗嶈嶘㢝㦛𢤱𢣚𢣭愻憹𢠼憢懀㦎懎𤢻戰𢷮𢶫摋擫𢹿擣斅斸曥𣋋𦢈腪脥臗槫桱
  欍𣠲楇橯樤樠欓㰙㯤𣞻檭𣝕欘𣠩殢𣯴𣯩氭湋潕㵗澅𣿉𪷓𤅶濆灙𤁣瀃熓㷍爄熌爖熚熉㷿𤒎𤓩熡𤓎𤑳𤛮𤢟獩玁㺏瓕瓛𤳸癐𤸫㿗㿧皟麬䀉𥌃䀹𥊝瞤䁪䂎礒𥖅𥕥碙𥞵𥨐竚𥪂籅䉙籋篘𥵊𥸠䉲篸𥵃𥼽䊭𥽖𥿊緷綇綀繟緍縺緸𦂅䋿縎緰䌈
  𦃄䌋䌰縬繓䌖繏䌟䌝䌥繻䍽朥膢𦣎𦪽蓧䕳爇𦾟蘟𧕟䗿𧎈蠙蠀蠾𧔥䙱襰𧟀詀𧳟䞈買𧶔賬䝻賟贃𨇁躘𨄣𨅍𨈊𨈌䠱𨇞躝軉軗𨊻𨏠輄𨎮𨏥䢨𨣞𨣧𨢿𨣈𨤻鎷釳𨥛鈠鈋鈲鈯鉁龯銶鋉鍄𨧱錂鏆鎯鍮鎝𨫒鐄鏉鐎鐏𨮂䥩䦳𨳕𨳑閍閐䦘𨴗𨵩𨵸
  𨶀𨶏𨶲𨶮𨷲𨽏䧢䪏𩏪𩎢䪘䪗顂𩓣顃䫴颰𩗀䬞𩘹𩘀颷颾𩘺𩘝䬘䬝𩙈𩚛𩚥𩚵𩛆𩛩𩟐𩜦䭀䭃𩜇𩜵𩝔餸𩞄𩞦𩠴𩡣𩡺駎𩤊䮾駚𩢡䭿𩢾驋䮝𩥉駧𩢸駩𩢴𩣏𩣫駶𩣵𩣺䮠騔䮞驄騝騪𩤸𩤙䮫騟𩤲騚𩥄𩥑𩥇龭䮳𩧆䯤𩭙𩰀鬖𩯳𩰹𩳤𩴵魥𩵩𩵹鯶𩶱
  鮟𩶰鯄䲖鮸𩷰𩸃𩸦鯱䱙䱬䱰鱇𩽇䲰鳼𩿪𪀦鴲鴜𪁈鷨𪀾𪁖鵚𪂆𪃏𪃍鷔𪄕𪄆𪇳䴬麲麨䴴麳䵳𪔵𪘀𪘯𠿕凙㔋勣𧷎㓄𠬙唓㖮嚛𠽃噹嘺嘪噞嗹㗿嘳𡃄㘓𡃤𡂡嚽𡅯囒圞墲埬堚塿𡓁壣𧹈孇嬣嬻孾寠㞞屩崙𡸗輋巗𡹬㟺巊巘𡿖幝幩廬㢗廧𢍰
  彃徿𢤩㦞憸𢣐𢤿𢯷摐擟𢶒掚撊㨻㩋撧𢺳攋㪎曊膹梖櫅欐檵櫠欇𣜬欑毊霼濿溡𤄷𣽏㵾灒熂煇𤑹𤓌爥𤒻𤘀𤜆犞獊𤠮㺜猌瑽瓄瑻璝㻶𤬅畼𤳷痮𤷃㿖𤺔瘱盨睍眝矑矉𥏝𥖲礮𥗇𥜰𥜐䅐䅳𥢷䆉竱鴗𥶽䉑𥯤䉶𥴼簢簂䉬𥴨𥻦𩏷糺䊺紟䋃𥾯
  䋔絁絙絧絥繷繨纚𦀖綖絺䋦𦅇綟緤緮䋼𦃩縍繬縸縰繂𦅈繈繶纁纗䍤羵𦒀䎙𦔖聻𦟼𦡝𦧺艣𦱌蔿蒭蕽蕳葝蔯蕝薆藷䗅蠦蟜𧒯蟳蟂蟘䙔襗襓襘襀襵𧞫覼覛𧡴𧢄覹䚩𧭹訑訞訜詓諫𧦝𧦧䛄詑譊詷譑誂譨誺誫諣誋䛳誷𧩕誳諴諰諯謏諥
  謱謸𧩼謉謆謯𧫝譆𧬤譞𧭈譾豵貗贚䝭𧸘賝䞋贉贑䞓䟐䟆𧽯䟃䠆蹳蹻𨂐蹔𨇽𨆪𨇰𨇤軏軕轣軜軷軨軬𨎌軿𨌈輢輖輗輨輷輮𨍰轊轇轐轗轠遱鄟鄳醶釟釨鈇鈛鏦鈆𨥟鉔鉠𨪕銈銊鐈銁𨰋鉾鋠鋗𫒡錽錤鐪錜𨨛錝錥𨨢鍊鐼鍉𨰲鍒鎍䥯鎞
  鎙𨰃鏥䥗鏾鐇鐍𨬖𨭸𨭖𨮳𨯟鑴𨰥𨲳開閒閗閞𨴹閵䦯闑𨼳𩀨霣𩅙靧䪊鞾𩎖韠𩏂韛韝𩏠𩑔䪴䪾𩒎顗頫䫂䫀䫟頵𩔳𩓥顅𩔑願顣䫶䫻𩗓𩗴䬓飋𩟗飦䬧餦𩚩飵飶𩛌餫餔餗𩛡饠餧餬餪餵餭餱䭔䭑𩝽饘饟馯馼駃駞駊駤駫駻騃騉騊騄騠騜
  騵騴騱騻䮰驓驙驨鬠𩯁鱮魟鰑鱄魦魵𩶁䱁䱀鮅鮄鮤鮰鰤鮆鮯𩻮鯆鮿鮵䲅𩸄鯬𩸡䱧鯞鰋鯾鰦鰕鰫鰽𩻗𩻬鱊鱢𩼶鱲鳽鳷鴀鴅鴃鸗𩿤鴔鸋鴥鴐鵊鴮𪀖鵧鴳鴽鶰䳜鵟䳤鶭䳢鵫鵰鵩鷤鶌鶒鶦鶗𪃧䳧𪃒䳫鷅𪆷鷐鷩𪅂鷣鷷䴋𪉸麷䴱𪌭䴽
  𪍠䵴𪓰䶕齧齩𫜦齰齭齴𪙏齾龓䶲㑮𠐊㛝㜐媈嬦𡟫婡嬇孆孄嶹𦠅潣澬㶆灍爧爃𤛱㹽珼璾𤩂璼璊𥢶絍綋綡緟𦆲䖅䕤訨詊譂誴䜖䡐䡩䡵𨞺𨟊釚釲鈖鈗銏鉝鉽鉷䤤銂鐽𨧰𨩰鎈䥄鑉閝韚頍𩖰䫾䮄騼𩦠𩵦魽䱸鱆𩿅齯僤𣍐𪋿噁㘔塸埨𡑍
  墠娙㠣嵽廞彄暐晛梜櫍澫浿漍熰燖燀瓅璗璕礐𥗽篢紃紞絪綎綄綪綝綧縯纆纕蔄䓣蘋虉蝀訏詝諓詪諲諟譓軝輶鄩醲釴錀鋹釿鉥鉮鑪鉊鉧𨧀鋐錞𨨏鍭鎓鏏鏚䥕𨭎𨭆鏻鐩闉隑隮隤頔頠駓駉駪駼騑騞驎鮈鮀鮠鮡鯻鰊鱀鰶鱚鵏鶠鸑
  鶱鷟鷭鷿齘齮齼繐菕譅鋂鑀𪈼
`

/** 排版空白（与真源同判：换行与缩进不参与建表）。 */
function isGlyphChar(ch) {
  return ch !== '\n' && ch !== ' ' && ch !== '\r'
}

let S2T_MAP = null
/** 逐字表（懒建；键 / 值均按**码位**切分）。 */
function s2tGlyphMap() {
  if (S2T_MAP) return S2T_MAP
  const source = Array.from(S2T_GLYPH_SOURCE).filter(isGlyphChar)
  const target = Array.from(S2T_GLYPH_TARGET).filter(isGlyphChar)
  const size = Math.min(source.length, target.length)
  const map = new Map()
  for (let i = 0; i < size; i += 1) map.set(source[i], target[i])
  S2T_MAP = map
  return S2T_MAP
}

let T2S_MAP = null
/**
 * 繁→简**反查层**（**只用于「朝代词前缀」的简体形派生**，不参与简→繁归一）：
 * ＝ 同一张 s2t 逐字表**取反**（首个来源字胜出）；表未覆盖的字**原样保留**。
 * **不是第二份对照表** —— 值仍逐字来自同一张真源表。
 */
function t2sGlyphMap() {
  if (T2S_MAP) return T2S_MAP
  const inverse = new Map()
  for (const [from, to] of s2tGlyphMap()) {
    if (!inverse.has(to)) inverse.set(to, from)
  }
  T2S_MAP = inverse
  return T2S_MAP
}

/* ---------------------------------------------------------------------------
 * 归一（§3.82.1：**恰五步、定序**；只作用于比对中间形）
 * ------------------------------------------------------------------------- */

function textOf(value) {
  return value === undefined || value === null ? '' : String(value)
}

/** ① 去空白（首尾 ＋ 内部多余空白一律去掉；`\s` 已含全角空格 U+3000）。 */
function stripWhitespace(value) {
  return value.replace(/\s+/g, '')
}

/** ② 去括号（`（）()` 及其包裹内容；内层优先、**有界**迭代防病态嵌套）。 */
function stripBrackets(value) {
  let out = value
  for (let round = 0; round < 8; round += 1) {
    const next = out.replace(/[（(][^（()）]*[）)]/g, '')
    if (next === out) break
    out = next
  }
  return out
}

/**
 * 朝代词前缀表（**按既有朝代值域表裁**）：
 *   · 15 类当前值 ＝ `src/data/seed.js::DYNASTY_OPTIONS`（繁体字面，逐字照登）；
 *   · 库内旧值 / 规范举例 ＝ `明` / `清` / `近現代`（seed.js 登记的未归一旧值）＋
 *     §3.82.1 举例的 `清代` / `明代`（**只登记朝代词本身，不发明新朝代**）。
 * 简体形**不手写**：由同一张 s2t 表取反派生（见 `t2sGlyphMap`）⇒ 与真源同值。
 */
const DYNASTY_WORDS = Object.freeze([
  '商周暨春秋',
  '戰國',
  '秦',
  '漢',
  '魏晉',
  '隋唐',
  '宋元',
  '明早中期',
  '晚明',
  '清初',
  '清中期',
  '晚清',
  '民國',
  '新中國',
  '當代',
  /* 库内旧值（seed.js：`戰國` / `明` / `清` / `近現代` 映射不到、保留原样）＋规范举例。 */
  '明',
  '清',
  '近現代',
  '清代',
  '明代'
])

let DYNASTY_PREFIXES = null
/** 朝代前缀表（长词在前 ⇒ 「明早中期」先于「明」被裁；繁简两形同表）。 */
function dynastyPrefixes() {
  if (DYNASTY_PREFIXES) return DYNASTY_PREFIXES
  const inverse = t2sGlyphMap()
  const words = new Set()
  for (const word of DYNASTY_WORDS) {
    if (word === '') continue
    words.add(word)
    /* 简体形：逐字查反查表（查不到 ⇒ 该字繁简同形、原样保留）。 */
    words.add(Array.from(word).map((ch) => inverse.get(ch) || ch).join(''))
  }
  DYNASTY_PREFIXES = Array.from(words).sort((a, b) => b.length - a.length)
  return DYNASTY_PREFIXES
}

/**
 * ③ 去朝代前缀：**只裁开头一个最长朝代词**，且**裁后至少剩 2 字**（裁成 0 / 1 字
 * ⇒ 那不是「前缀」而是全部 ⇒ 不裁、不猜）。
 */
function stripDynastyPrefix(value) {
  for (const word of dynastyPrefixes()) {
    if (value.startsWith(word) && value.length - word.length >= 2) {
      return value.slice(word.length)
    }
  }
  return value
}

/** ④ 全角 → 半角（全角字母 / 数字 / 标点 U+FF01〜U+FF5E ⇒ 对应半角；空白已在①去掉）。 */
function toHalfWidth(value) {
  return value.replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
}

/** ⑤ 简 → 繁（逐字表；**表未覆盖的字原样保留、不猜**）。 */
function toTraditional(value) {
  const map = s2tGlyphMap()
  let out = ''
  for (const ch of value) out += map.get(ch) || ch
  return out
}

/**
 * **作者名归一（五步、定序）**：去空白 → 去括号 → 去朝代前缀 → 全角→半角 → 简→繁。
 * 纯函数、幂等（已是规范形 ⇒ 原样返回）、不抛错；非字符串入参按 `''` 处理。
 * 归一形**只用于**四道匹配 / 包含比对、回包 `normalized`、`author_match.normalized`。
 * @param {string} raw 作者名原文
 * @returns {string} 归一形
 */
function normalizeAuthorName(raw) {
  const step1 = stripWhitespace(textOf(raw))
  const step2 = stripBrackets(step1)
  const step3 = stripDynastyPrefix(step2)
  const step4 = toHalfWidth(step3)
  return toTraditional(step4)
}

/* ---------------------------------------------------------------------------
 * 印人行读法（显示名单点派生 ＝ `src/data/db.js::personDisplayName` 的同尺转发；
 * **不落盘、不在 persons 行建第二份显示名**）
 * ------------------------------------------------------------------------- */

function firstTextOf(list) {
  if (!Array.isArray(list)) return ''
  const hit = list.find((item) => textOf(item).trim() !== '')
  return hit === undefined ? '' : String(hit)
}

/** 印人显示名：`姓 + 名` → 缺则 `字[0]` → 缺则 `號[0]` → 皆空 ⇒ `''`。 */
function personDisplayNameOf(row) {
  if (!row || typeof row !== 'object') return ''
  const family = textOf(row.family_name)
  const given = textOf(row.given_name)
  const full = `${family}${given}`
  if (full !== '') return full
  const courtesy = firstTextOf(row.courtesy_names)
  if (courtesy !== '') return courtesy
  return firstTextOf(row.art_names)
}

/** 印人行主键：`id` 优先、缺则 `_id`（与 `personExistsById` 的 id 口径同源）。 */
function personIdOf(row) {
  if (!row || typeof row !== 'object') return ''
  return textOf(row.id).trim() || textOf(row._id).trim()
}

function listOf(value) {
  return Array.isArray(value) ? value.map((item) => textOf(item).trim()).filter((item) => item !== '') : []
}

/* ---------------------------------------------------------------------------
 * 四道匹配 ＋ 包含（纯函数；分数封闭五值）
 * ------------------------------------------------------------------------- */

/**
 * 单人最佳命中（**每人至多一条候选**）：先四道精确（`name` → `alias` → `courtesy`
 * → `art`，**高分优先**），全不中再做 `contains`（双向子串：人名含查询 / 查询含人名，
 * 精确命中已先行 ⇒ 此处只收严格包含）。
 * @param {string} normalizedQuery 归一后的查询串
 * @param {object} personRow 印人行
 * @returns {null|{field:string, score:number, value:string}} 无命中 ⇒ `null`
 */
function matchPerson(normalizedQuery, personRow) {
  const query = textOf(normalizedQuery)
  if (query === '' || !personRow || typeof personRow !== 'object') return null
  const fields = [
    { field: 'name', values: [personDisplayNameOf(personRow)] },
    { field: 'alias', values: listOf(personRow.alias_names) },
    { field: 'courtesy', values: listOf(personRow.courtesy_names) },
    { field: 'art', values: listOf(personRow.art_names) }
  ]
  const normalized = fields.map((entry) => ({
    field: entry.field,
    values: entry.values.map((value) => ({ value, norm: normalizeAuthorName(value) })).filter((item) => item.norm !== '')
  }))
  /* ① 四道精确（分数面即优先序）。 */
  for (const entry of normalized) {
    const hit = entry.values.find((item) => item.norm === query)
    if (hit) return { field: entry.field, score: FIELD_SCORES[entry.field], value: hit.value }
  }
  /* ② 包含（`contains` = 50；只进候选、**永不回填**）。 */
  for (const entry of normalized) {
    const hit = entry.values.find((item) => item.norm.indexOf(query) !== -1 || query.indexOf(item.norm) !== -1)
    if (hit) return { field: 'contains', score: FIELD_SCORES.contains, value: hit.value }
  }
  return null
}

/**
 * 全库最佳命中（`repairAuthorPersonId` 回填判定用）：同分取 `person_id` 字典序小者。
 * @param {string} normalizedQuery 归一后的查询串
 * @param {Array<object>} personRows 印人行集
 * @returns {null|{person_id:string, display_name:string, field:string, score:number}}
 */
function bestMatchOf(normalizedQuery, personRows) {
  let best = null
  for (const row of Array.isArray(personRows) ? personRows : []) {
    const personId = personIdOf(row)
    if (personId === '') continue
    const hit = matchPerson(normalizedQuery, row)
    if (!hit) continue
    if (
      best === null ||
      hit.score > best.score ||
      (hit.score === best.score && personId < best.person_id)
    ) {
      best = { person_id: personId, display_name: personDisplayNameOf(row), field: hit.field, score: hit.score }
    }
  }
  return best
}

/**
 * 候选列表（**排序只定序、不改数据**）：`score` 降序 → 同分取 `person_id` 字典序小者
 * （分数面按字段封闭 ⇒ 同分必同 `field`）；截断到 `limit`。
 * @param {string} normalizedQuery 归一后的查询串
 * @param {Array<object>} personRows 印人行集
 * @param {number} limit 1〜10
 * @param {string} [currentPersonId] 该印面**当前** `author_person_id`（⇒ `is_current`）
 * @returns {Array<object>} 每元素**恰 7 键**
 */
function buildCandidates(normalizedQuery, personRows, limit, currentPersonId) {
  const query = textOf(normalizedQuery)
  const current = textOf(currentPersonId)
  if (query === '') return []
  const out = []
  for (const row of Array.isArray(personRows) ? personRows : []) {
    const personId = personIdOf(row)
    if (personId === '') continue
    const hit = matchPerson(query, row)
    if (!hit) continue
    out.push({
      person_id: personId,
      display_name: personDisplayNameOf(row),
      dynasty: textOf(row.dynasty).trim(),
      matched_field: hit.field,
      matched_value: hit.value,
      score: hit.score,
      /* **由真源派生、不编造**：该人是否为**当前这枚印面的作者引用**（无印面上下文 ⇒ 恒 false）。 */
      is_current: current !== '' && personId === current
    })
  }
  out.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    if (a.person_id === b.person_id) return 0
    return a.person_id < b.person_id ? -1 : 1
  })
  const max = Number.isInteger(limit) && limit > 0 ? limit : SUGGEST_AUTHORS_DEFAULT_LIMIT
  return out.slice(0, max)
}

/* ---------------------------------------------------------------------------
 * 载荷门（**全部判定早于任何读**；键面门单点复用 `lib/ops.js::pointsPayloadDenial`
 * ⇒ 未知键 / 身份类键的文案与其余 op 同一条）
 * ------------------------------------------------------------------------- */

function payloadGateOf(payload, allowedKeys) {
  /* 延迟 require：打破加载环（`lib/ops.js` 对本文件的依赖同样是延迟的）。 */
  const ops = require('./ops.js')
  return ops.pointsPayloadDenial(payload, allowedKeys)
}

/**
 * `suggestAuthors` 载荷解析（封闭恰 3 键；**任一不合 ⇒ 结构化拒绝 ＋ 零读**）。
 * 判定序：键面（未知 / 身份类 ⇒ `INVALID_FIELD`）→ `face_id` / `name` 形态 → `limit`
 * 值域 → 两键皆空（`MISSING_REQUIRED`）。
 * @param {object} [payload] 载荷
 * @returns {{ok:true, value:{face_id:string, name:string, limit:number}}|
 *           {ok:false, reason:string, message:string}}
 */
function parseSuggestAuthorsPayload(payload) {
  const gate = payloadGateOf(payload, SUGGEST_AUTHORS_ALLOWED_KEYS)
  if (gate) return gate
  const input = payload || {}
  let faceId = ''
  if (Object.prototype.hasOwnProperty.call(input, 'face_id')) {
    if (typeof input.face_id !== 'string') {
      return deny(REASONS.INVALID_VALUE, '`face_id` 必須是字符串（空串＝不給印面）；本次零讀取。')
    }
    faceId = input.face_id
  }
  let name = ''
  if (Object.prototype.hasOwnProperty.call(input, 'name')) {
    if (typeof input.name !== 'string') {
      return deny(REASONS.INVALID_VALUE, '`name` 必須是字符串（空串＝不給姓名）；本次零讀取。')
    }
    name = input.name
  }
  let limit = SUGGEST_AUTHORS_DEFAULT_LIMIT
  if (Object.prototype.hasOwnProperty.call(input, 'limit')) {
    const raw = input.limit
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > SUGGEST_AUTHORS_MAX_LIMIT) {
      return deny(REASONS.INVALID_VALUE, `\`limit\` 必須是 1〜${SUGGEST_AUTHORS_MAX_LIMIT} 的整數（不得靜默夾取）；本次零讀取。`)
    }
    limit = raw
  }
  if (faceId.trim() === '' && name.trim() === '') {
    return deny(REASONS.MISSING_REQUIRED, '缺少查詢條件（`face_id` / `name` 至少給一個非空）；本次零讀取。')
  }
  return { ok: true, value: { face_id: faceId, name, limit } }
}

/**
 * `repairAuthorPersonId` 载荷解析（封闭恰 3 键；**任一不合 ⇒ 结构化拒绝 ＋ 零读写**）。
 * 判定序：键面 → `dry_run`（缺省 `true`）→ `limit`（1〜500、缺省 200）→ `cursor`
 * （字符串、缺省 `''`）。
 * @param {object} [payload] 载荷
 * @returns {{ok:true, value:{dry_run:boolean, limit:number, cursor:string}}|
 *           {ok:false, reason:string, message:string}}
 */
function parseRepairAuthorPersonIdPayload(payload) {
  const gate = payloadGateOf(payload, REPAIR_AUTHOR_PERSON_ID_ALLOWED_KEYS)
  if (gate) return gate
  const input = payload || {}
  let dryRun = true
  if (Object.prototype.hasOwnProperty.call(input, 'dry_run')) {
    if (typeof input.dry_run !== 'boolean') {
      return deny(REASONS.INVALID_VALUE, '`dry_run` 必須是布林值（true / false）；本次零寫入。')
    }
    dryRun = input.dry_run
  }
  let limit = REPAIR_AUTHOR_PERSON_ID_DEFAULT_LIMIT
  if (Object.prototype.hasOwnProperty.call(input, 'limit')) {
    const raw = input.limit
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > REPAIR_AUTHOR_PERSON_ID_MAX_LIMIT) {
      return deny(REASONS.INVALID_VALUE, `\`limit\` 必須是 1〜${REPAIR_AUTHOR_PERSON_ID_MAX_LIMIT} 的整數；本次零寫入。`)
    }
    limit = raw
  }
  let cursor = ''
  if (Object.prototype.hasOwnProperty.call(input, 'cursor')) {
    if (typeof input.cursor !== 'string') {
      return deny(REASONS.INVALID_VALUE, '`cursor` 必須是字符串（上一輪窗口末行 `_id`）；本次零寫入。')
    }
    cursor = input.cursor.trim()
  }
  return { ok: true, value: { dry_run: dryRun, limit, cursor } }
}

/* ---------------------------------------------------------------------------
 * `xiai_seal_links` 补条行（印章级命中；**幂等**，键面沿 `importRelations` 那套）
 * ---------------------------------------------------------------------------
 * 行面 ＝ `lib/importChannels.js::RELATION_SEAL_LINK_ROW_KEYS` 七键
 * （`source_seal_id` / `link_kind` / `ref_id` / `ref_name` / `bridge_item_id` /
 * `source_face` / `seq`）＋ `id` / `source` / `unresolved` / `created_at`
 * ＋ 本回填面的标记键 `kind: '印人'`（幂等判据三元组 ＝
 * (`source_seal_id`, `ref_id`, `kind`)，见 §3.82.3 / AC-717）。
 */

/** 关联标记值（**印人**；幂等三元组的第三元）。 */
const SEAL_LINK_KIND = '印人'
/** 补条来源标记（本回填面自报来源；**不冒充外部导入批次**）。 */
const SEAL_LINK_SOURCE = 'author-repair'
/** 行 `id` 前缀（与 `importRelations` 同族）＋ 摘要位数。 */
const SEAL_LINK_ID_PREFIX = 'sl-'
const SEAL_LINK_ID_HEX_LENGTH = 16
/** 补条 `link_kind`：沿既有封闭四值中的 `person_zzkz`（**作者＝篆者**；不新增第五值）。 */
const SEAL_LINK_VALUE = 'person_zzkz'
/** 补条封闭键面（**恰 12 键**；顺序即行键序）。 */
const SEAL_LINK_ROW_KEYS = Object.freeze([
  'source_seal_id',
  'link_kind',
  'ref_id',
  'ref_name',
  'bridge_item_id',
  'source_face',
  'seq',
  'kind',
  'id',
  'source',
  'unresolved',
  'created_at'
])

/**
 * 构造一条印章级 `印人` 关联行（**纯函数**；`id` 由调用方经 `lib/ops.js::hash16`
 * 确定性给出 ⇒ 同一 `(来源, 印章, 印人)` 恒落同一行）。
 * @param {{sealId:string, personId:string, refName:string, id:string, at:string}} parts
 * @returns {object} 恰 12 键的行
 */
function sealLinkRowOf(parts) {
  const sealId = textOf(parts && parts.sealId)
  const personId = textOf(parts && parts.personId)
  return {
    source_seal_id: sealId,
    link_kind: SEAL_LINK_VALUE,
    ref_id: personId,
    ref_name: textOf(parts && parts.refName),
    bridge_item_id: null,
    source_face: 'face_row',
    seq: null,
    kind: SEAL_LINK_KIND,
    id: textOf(parts && parts.id),
    source: SEAL_LINK_SOURCE,
    unresolved: false,
    created_at: textOf(parts && parts.at)
  }
}

/** 确定性行 `id`（`sl-` ＋ `(source, sealId, kind, personId)` 摘要前 16 位）。 */
function sealLinkIdInputOf(sealId, personId) {
  return `${SEAL_LINK_SOURCE}${textOf(sealId)}${SEAL_LINK_KIND}${textOf(personId)}`
}

module.exports = {
  /* 冻结键面（供两个 op、`index.js` 透传与离线自检直接断言） */
  SUGGEST_AUTHORS_ALLOWED_KEYS,
  SUGGEST_AUTHORS_SUCCESS_KEYS,
  AUTHOR_CANDIDATE_KEYS,
  SUGGEST_AUTHORS_DEFAULT_LIMIT,
  SUGGEST_AUTHORS_MAX_LIMIT,
  REPAIR_AUTHOR_PERSON_ID_ALLOWED_KEYS,
  REPAIR_AUTHOR_PERSON_ID_DEFAULT_LIMIT,
  REPAIR_AUTHOR_PERSON_ID_MAX_LIMIT,
  REPAIR_AUTHOR_PERSON_ID_READOUT_KEYS,
  REPAIR_AUTHOR_PERSON_ID_SAMPLE_KEYS,
  REPAIR_AUTHOR_PERSON_ID_FAILED_KEYS,
  AUTHOR_MATCH_KEYS,
  MATCHED_FIELDS,
  FIELD_SCORES,
  BACKFILL_MIN_SCORE,
  SEAL_LINK_KIND,
  SEAL_LINK_SOURCE,
  SEAL_LINK_ID_PREFIX,
  SEAL_LINK_ID_HEX_LENGTH,
  SEAL_LINK_ROW_KEYS,
  /* 纯函数（离线自检直接断言） */
  normalizeAuthorName,
  personDisplayNameOf,
  personIdOf,
  matchPerson,
  bestMatchOf,
  buildCandidates,
  parseSuggestAuthorsPayload,
  parseRepairAuthorPersonIdPayload,
  sealLinkRowOf,
  sealLinkIdInputOf,
  /* 逐字表（离线自检可复算「与真源同值」） */
  S2T_GLYPH_SOURCE,
  S2T_GLYPH_TARGET
}
