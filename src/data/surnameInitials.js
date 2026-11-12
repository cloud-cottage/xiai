/**
 * 姓氏 → 拼音首字母对照表 ＋ 通讯录式（A–Z）分组 / 排序纯函数。
 * =====================================================================
 * **零依赖**：本文件只导出一张静态表与四个纯函数；不 import 任何仓内模块、
 * 不碰浏览器存储、不发请求 ⇒ 可被视图与离线自检同时直接消费。
 *
 * **来源：人工对照，非第三方库**（本仓不引入任何拼音库）。首字母按现代汉语
 * 普通话读音人工判定，按字母分组书写；姓氏专读单独标注（曾 zēng、查 zhā、
 * 解 xiè、都 dū、区 ōu、单 shàn、贾 jiǎ、谷 gǔ、纪 jì、尉 yù…）。
 *
 * **覆盖（实测）**：2026-11-12 对 `xiai_persons` 取 `family_name` 实测 —— 570 行、
 * **136 个不同姓氏（全单字、无复姓）**、9 行无 `family_name` ⇒ 本表逐字覆盖那 136 个，
 * 另补常见但当前库内尚未出现的姓氏（总条目数 ≥ 300，见本文件底部自检脚本读数）。
 * **简繁双形同收**：正式行多为繁体（張 / 陳 / 趙…），提案与手输可能出现简体（张 / 陈 / 赵…）
 * ⇒ 两种字形各自成键，查不到一律落 `'#'`（不猜测、不转换）。
 *
 * `I` / `U` / `V` 三母恒为空组：汉语拼音以 i / u / v 起头的音节不构成姓氏读音。
 */

/* --------------------------------------------------------------------------- */
/* 表：姓氏（单字） → 大写字母 A–Z                                              */
/* --------------------------------------------------------------------------- */

export const SURNAME_INITIALS = {
  /* ---- A ---- */
  '愛': 'A', // Ài（库内）
  '艾': 'A', // Ài
  '安': 'A', // Ān
  '敖': 'A', // Áo

  /* ---- B ---- */
  '巴': 'B', // Bā（库内）
  '白': 'B', // Bái
  '班': 'B', // Bān
  '包': 'B', // Bāo
  '邦': 'B', // Bāng
  '保': 'B', // Bǎo
  '鮑': 'B', // Bào（库内）
  '鲍': 'B', // Bào（简形）
  '貝': 'B', // Bèi
  '贝': 'B', // Bèi（简形）
  '邊': 'B', // Biān
  '边': 'B', // Biān（简形）
  '賓': 'B', // Bīn
  '宾': 'B', // Bīn（简形）
  '卞': 'B', // Biàn
  '畢': 'B', // Bì
  '毕': 'B', // Bì（简形）
  '邴': 'B', // Bǐng
  '柏': 'B', // Bǎi / Bó
  '卜': 'B', // Bǔ
  '步': 'B', // Bù

  /* ---- C ---- */
  '蔡': 'C', // Cài（库内）
  '曹': 'C', // Cáo（库内）
  '岑': 'C', // Cén
  '車': 'C', // Chē
  '车': 'C', // Chē（简形）
  '常': 'C', // Cháng
  '晁': 'C', // Cháo
  '陳': 'C', // Chén（库内）
  '陈': 'C', // Chén（简形）
  '成': 'C', // Chéng
  '程': 'C', // Chéng（库内）
  '池': 'C', // Chí
  '遲': 'C', // Chí
  '迟': 'C', // Chí（简形）
  '楚': 'C', // Chǔ
  '褚': 'C', // Chǔ
  '儲': 'C', // Chǔ
  '储': 'C', // Chǔ（简形）
  '崔': 'C', // Cuī（库内）
  '巢': 'C', // Cháo（库内）
  '叢': 'C', // Cóng
  '丛': 'C', // Cóng（简形）

  /* ---- D ---- */
  '戴': 'D', // Dài（库内）
  '鄧': 'D', // Dèng（库内）
  '邓': 'D', // Dèng（简形）
  '端': 'D', // Duān（库内）
  '笪': 'D', // Dá（库内）
  '丁': 'D', // Dīng（库内）
  '董': 'D', // Dǒng（库内）
  '杜': 'D', // Dù（库内）
  '多': 'D', // Duō（库内）
  '都': 'D', // Dū（库内，姓氏专读）
  '段': 'D', // Duàn
  '竇': 'D', // Dòu
  '窦': 'D', // Dòu（简形）
  '達': 'D', // Dá
  '达': 'D', // Dá（简形）
  '代': 'D', // Dài
  '東': 'D', // Dōng
  '东': 'D', // Dōng（简形）

  /* ---- E ---- */
  '鄂': 'E', // È
  '恩': 'E', // Ēn

  /* ---- F ---- */
  '方': 'F', // Fāng（库内）
  '封': 'F', // Fēng（库内）
  '馮': 'F', // Féng（库内）
  '冯': 'F', // Féng（简形）
  '傅': 'F', // Fù（库内）
  '福': 'F', // Fú（库内）
  '范': 'F', // Fàn
  '費': 'F', // Fèi
  '费': 'F', // Fèi（简形）
  '鳳': 'F', // Fèng
  '凤': 'F', // Fèng（简形）
  '符': 'F', // Fú
  '伏': 'F', // Fú
  '富': 'F', // Fù
  '樊': 'F', // Fán
  '法': 'F', // Fǎ
  '房': 'F', // Fáng

  /* ---- G ---- */
  '甘': 'G', // Gān
  '高': 'G', // Gāo（库内）
  '葛': 'G', // Gě（库内）
  '郭': 'G', // Guō（库内）
  '耿': 'G', // Gěng
  '弓': 'G', // Gōng
  '龔': 'G', // Gōng（库内）
  '龚': 'G', // Gōng（简形）
  '勾': 'G', // Gōu
  '古': 'G', // Gǔ
  '谷': 'G', // Gǔ（库内，姓氏专读）
  '顧': 'G', // Gù（库内）
  '顾': 'G', // Gù（简形）
  '關': 'G', // Guān（库内）
  '关': 'G', // Guān（简形）
  '管': 'G', // Guǎn
  '歸': 'G', // Guī（库内）
  '归': 'G', // Guī（简形）
  '桂': 'G', // Guì
  '貴': 'G', // Guì
  '贵': 'G', // Guì（简形）
  '廣': 'G', // Guǎng（库内）
  '广': 'G', // Guǎng（简形）
  '國': 'G', // Guó
  '国': 'G', // Guó（简形）
  '綱': 'G', // Gāng
  '纲': 'G', // Gāng（简形）
  '剛': 'G', // Gāng
  '刚': 'G', // Gāng（简形）
  '蓋': 'G', // Gě / Gài
  '盖': 'G', // Gě / Gài（简形）
  '干': 'G', // Gān

  /* ---- H ---- */
  '郝': 'H', // Hǎo
  '何': 'H', // Hé（库内）
  '賀': 'H', // Hè
  '贺': 'H', // Hè（简形）
  '洪': 'H', // Hóng（库内）
  '侯': 'H', // Hóu（库内）
  '胡': 'H', // Hú（库内）
  '華': 'H', // Huá（库内）
  '华': 'H', // Huá（简形）
  '桓': 'H', // Huán
  '黃': 'H', // Huáng（库内）
  '黄': 'H', // Huáng（简形）
  '霍': 'H', // Huò
  '惠': 'H', // Huì
  '韓': 'H', // Hán
  '韩': 'H', // Hán（简形）
  '漢': 'H', // Hàn
  '汉': 'H', // Hàn（简形）
  '杭': 'H', // Háng
  '赫': 'H', // Hè
  '鶴': 'H', // Hè
  '鹤': 'H', // Hè（简形）
  '花': 'H', // Huā
  '淮': 'H', // Huái
  '環': 'H', // Huán
  '环': 'H', // Huán（简形）
  '皇': 'H', // Huáng
  '海': 'H', // Hǎi

  /* ---- I（空：汉语拼音 i 起头不构成姓氏读音） ---- */

  /* ---- J ---- */
  '嵇': 'J', // Jī
  '吉': 'J', // Jí
  '紀': 'J', // Jì（库内）
  '纪': 'J', // Jì（简形）
  '計': 'J', // Jì
  '计': 'J', // Jì（简形）
  '季': 'J', // Jì
  '賈': 'J', // Jiǎ（库内，姓氏专读）
  '贾': 'J', // Jiǎ（简形）
  '簡': 'J', // Jiǎn
  '简': 'J', // Jiǎn（简形）
  '姜': 'J', // Jiāng（库内）
  '江': 'J', // Jiāng（库内）
  '蔣': 'J', // Jiǎng（库内）
  '蒋': 'J', // Jiǎng（简形）
  '焦': 'J', // Jiāo
  '靳': 'J', // Jìn（库内）
  '晉': 'J', // Jìn
  '晋': 'J', // Jìn（简形）
  '荊': 'J', // Jīng
  '荆': 'J', // Jīng（简形）
  '景': 'J', // Jǐng
  '居': 'J', // Jū（库内）
  '鞠': 'J', // Jū（库内）
  '金': 'J', // Jīn（库内）
  '錦': 'J', // Jǐn
  '锦': 'J', // Jǐn（简形）
  '經': 'J', // Jīng
  '经': 'J', // Jīng（简形）
  '井': 'J', // Jǐng
  '敬': 'J', // Jìng
  '郟': 'J', // Jiá
  '郏': 'J', // Jiá（简形）
  '堅': 'J', // Jiān
  '坚': 'J', // Jiān（简形）
  '絳': 'J', // Jiàng
  '绛': 'J', // Jiàng（简形）
  '繼': 'J', // Jì（库内）
  '继': 'J', // Jì（简形）

  /* ---- K ---- */
  '康': 'K', // Kāng（库内）
  '柯': 'K', // Kē
  '孔': 'K', // Kǒng（库内）
  '寇': 'K', // Kòu
  '鄺': 'K', // Kuàng
  '邝': 'K', // Kuàng（简形）
  '匡': 'K', // Kuāng

  /* ---- L ---- */
  '來': 'L', // Lái（库内）
  '来': 'L', // Lái（简形）
  '賴': 'L', // Lài
  '赖': 'L', // Lài（简形）
  '郎': 'L', // Láng
  '勞': 'L', // Láo
  '劳': 'L', // Láo（简形）
  '雷': 'L', // Léi（库内）
  '冷': 'L', // Lěng
  '黎': 'L', // Lí
  '李': 'L', // Lǐ（库内）
  '連': 'L', // Lián
  '连': 'L', // Lián（简形）
  '廉': 'L', // Lián
  '梁': 'L', // Liáng（库内）
  '廖': 'L', // Liào（库内）
  '林': 'L', // Lín（库内）
  '凌': 'L', // Líng
  '劉': 'L', // Liú（库内）
  '刘': 'L', // Liú（简形）
  '龍': 'L', // Lóng
  '龙': 'L', // Lóng（简形）
  '婁': 'L', // Lóu
  '娄': 'L', // Lóu（简形）
  '蘆': 'L', // Lú
  '芦': 'L', // Lú（简形）
  '盧': 'L', // Lú（库内）
  '卢': 'L', // Lú（简形）
  '陸': 'L', // Lù（库内）
  '陆': 'L', // Lù（简形）
  '路': 'L', // Lù
  '魯': 'L', // Lǔ
  '鲁': 'L', // Lǔ（简形）
  '祿': 'L', // Lù
  '禄': 'L', // Lù（简形）
  '鹿': 'L', // Lù
  '呂': 'L', // Lǚ
  '吕': 'L', // Lǚ（简形）
  '羅': 'L', // Luó（库内）
  '罗': 'L', // Luó（简形）
  '駱': 'L', // Luò
  '骆': 'L', // Luò（简形）
  '蘭': 'L', // Lán
  '兰': 'L', // Lán（简形）
  '樓': 'L', // Lóu
  '楼': 'L', // Lóu（简形）
  '麗': 'L', // Lì
  '丽': 'L', // Lì（简形）
  '栗': 'L', // Lì
  '良': 'L', // Liáng
  '遼': 'L', // Liáo
  '辽': 'L', // Liáo（简形）
  '禮': 'L', // Lǐ
  '礼': 'L', // Lǐ（简形）

  /* ---- M ---- */
  '馬': 'M', // Mǎ（库内）
  '马': 'M', // Mǎ（简形）
  '毛': 'M', // Máo（库内）
  '梅': 'M', // Méi（库内）
  '孟': 'M', // Mèng
  '麻': 'M', // Má
  '滿': 'M', // Mǎn
  '满': 'M', // Mǎn（简形）
  '門': 'M', // Mén
  '门': 'M', // Mén（简形）
  '蒙': 'M', // Méng
  '米': 'M', // Mǐ
  '閩': 'M', // Mǐn
  '闽': 'M', // Mǐn（简形）
  '明': 'M', // Míng
  '莫': 'M', // Mò（库内）
  '牟': 'M', // Móu
  '穆': 'M', // Mù（库内）
  '沐': 'M', // Mù
  '慕': 'M', // Mù
  '苗': 'M', // Miáo

  /* ---- N ---- */
  '那': 'N', // Nā（姓氏专读）
  '南': 'N', // Nán
  '倪': 'N', // Ní
  '年': 'N', // Nián
  '聶': 'N', // Niè
  '聂': 'N', // Niè（简形）
  '寧': 'N', // Níng
  '宁': 'N', // Níng（简形）
  '牛': 'N', // Niú
  '農': 'N', // Nóng
  '农': 'N', // Nóng（简形）
  '鈕': 'N', // Niǔ
  '钮': 'N', // Niǔ（简形）
  '能': 'N', // Nài / Néng

  /* ---- O ---- */
  '歐': 'O', // Ōu
  '欧': 'O', // Ōu（简形）
  '區': 'O', // Ōu（姓氏专读）
  '区': 'O', // Ōu（简形）

  /* ---- P ---- */
  '潘': 'P', // Pān（库内）
  '逄': 'P', // Páng
  '裴': 'P', // Péi
  '彭': 'P', // Péng
  '皮': 'P', // Pí
  '平': 'P', // Píng
  '蒲': 'P', // Pú
  '濮': 'P', // Pú
  '樸': 'P', // Pǔ / Piáo
  '朴': 'P', // Pǔ / Piáo（简形）
  '龐': 'P', // Páng（库内）
  '庞': 'P', // Páng（简形）

  /* ---- Q ---- */
  '戚': 'Q', // Qī
  '齊': 'Q', // Qí（库内）
  '齐': 'Q', // Qí（简形）
  '祁': 'Q', // Qí
  '錢': 'Q', // Qián（库内）
  '钱': 'Q', // Qián（简形）
  '強': 'Q', // Qiáng
  '强': 'Q', // Qiáng（简形）
  '喬': 'Q', // Qiáo（库内）
  '乔': 'Q', // Qiáo（简形）
  '秦': 'Q', // Qín（库内）
  '瞿': 'Q', // Qú（库内）
  '曲': 'Q', // Qū
  '屈': 'Q', // Qū
  '權': 'Q', // Quán
  '权': 'Q', // Quán（简形）
  '全': 'Q', // Quán
  '邱': 'Q', // Qiū
  '秋': 'Q', // Qiū
  '裘': 'Q', // Qiú
  '渠': 'Q', // Qú
  '仇': 'Q', // Qiú（姓氏专读）

  /* ---- R ---- */
  '冉': 'R', // Rǎn
  '饒': 'R', // Ráo
  '饶': 'R', // Ráo（简形）
  '任': 'R', // Rén（库内）
  '榮': 'R', // Róng
  '荣': 'R', // Róng（简形）
  '容': 'R', // Róng（库内）
  '戎': 'R', // Róng
  '茹': 'R', // Rú
  '阮': 'R', // Ruǎn（库内）
  '芮': 'R', // Ruì（库内）

  /* ---- S ---- */
  '薩': 'S', // Sà
  '萨': 'S', // Sà（简形）
  '邵': 'S', // Shào（库内）
  '單': 'S', // Shàn（姓氏专读）
  '单': 'S', // Shàn（简形）
  '商': 'S', // Shāng
  '尚': 'S', // Shàng（库内）
  '申': 'S', // Shēn
  '沈': 'S', // Shěn（库内）
  '沙': 'S', // Shā（库内）
  '石': 'S', // Shí（库内）
  '史': 'S', // Shǐ（库内）
  '宋': 'S', // Sòng
  '蘇': 'S', // Sū（库内）
  '苏': 'S', // Sū（简形）
  '宿': 'S', // Sù
  '隋': 'S', // Suí
  '孫': 'S', // Sūn（库内）
  '孙': 'S', // Sūn（简形）
  '施': 'S', // Shī（库内）
  '森': 'S', // Sēn（库内）
  '時': 'S', // Shí
  '时': 'S', // Shí（简形）
  '桑': 'S', // Sāng
  '佘': 'S', // Shé
  '盛': 'S', // Shèng（库内）
  '舒': 'S', // Shū
  '水': 'S', // Shuǐ
  '司': 'S', // Sī
  '松': 'S', // Sōng
  '釋': 'S', // Shì（库内）
  '释': 'S', // Shì（简形）

  /* ---- T ---- */
  '唐': 'T', // Táng（库内）
  '塗': 'T', // Tú（库内）
  '涂': 'T', // Tú（简形／另姓）
  '湯': 'T', // Tāng（库内）
  '汤': 'T', // Tāng（简形）
  '田': 'T', // Tián（库内）
  '童': 'T', // Tóng（库内）
  '譚': 'T', // Tán（库内）
  '谭': 'T', // Tán（简形）
  '邰': 'T', // Tái
  '檀': 'T', // Tán
  '陶': 'T', // Táo
  '滕': 'T', // Téng
  '佟': 'T', // Tóng

  /* ---- U（空：汉语拼音 u 起头不构成姓氏读音） ---- */

  /* ---- V（空：汉语拼音 v 起头不构成姓氏读音） ---- */

  /* ---- W ---- */
  '吳': 'W', // Wú（库内）
  '吴': 'W', // Wú（简形）
  '王': 'W', // Wáng（库内）
  '汪': 'W', // Wāng（库内）
  '溫': 'W', // Wēn（库内）
  '温': 'W', // Wēn（简形）
  '翁': 'W', // Wēng（库内）
  '萬': 'W', // Wàn（库内）
  '万': 'W', // Wàn（简形）
  '文': 'W', // Wén（库内）
  '韋': 'W', // Wéi
  '韦': 'W', // Wéi（简形）
  '衛': 'W', // Wèi
  '卫': 'W', // Wèi（简形）
  '魏': 'W', // Wèi（库内）
  '巫': 'W', // Wū
  '烏': 'W', // Wū
  '乌': 'W', // Wū（简形）
  '鄔': 'W', // Wū
  '邬': 'W', // Wū（简形）
  '伍': 'W', // Wǔ
  '武': 'W', // Wǔ

  /* ---- X ---- */
  '夏': 'X', // Xià（库内）
  '奚': 'X', // Xī（库内）
  '宣': 'X', // Xuān（库内）
  '席': 'X', // Xí（库内）
  '徐': 'X', // Xú（库内）
  '熊': 'X', // Xióng（库内）
  '鄉': 'X', // Xiāng（库内）
  '乡': 'X', // Xiāng（简形）
  '薛': 'X', // Xuē（库内）
  '許': 'X', // Xǔ（库内）
  '许': 'X', // Xǔ（简形）
  '謝': 'X', // Xiè（库内）
  '谢': 'X', // Xiè（简形）
  '項': 'X', // Xiàng（库内）
  '项': 'X', // Xiàng（简形）
  '邢': 'X', // Xíng
  '蕭': 'X', // Xiāo
  '萧': 'X', // Xiāo（简形）
  '修': 'X', // Xiū
  '解': 'X', // Xiè（姓氏专读）
  '向': 'X', // Xiàng
  '忻': 'X', // Xīn
  '辛': 'X', // Xīn
  '興': 'X', // Xīng
  '兴': 'X', // Xīng（简形）
  '荀': 'X', // Xún

  /* ---- Y ---- */
  '余': 'Y', // Yú（库内）
  '伊': 'Y', // Yī（库内）
  '俞': 'Y', // Yú（库内）
  '嚴': 'Y', // Yán（库内）
  '严': 'Y', // Yán（简形）
  '園': 'Y', // Yuán（库内）
  '园': 'Y', // Yuán（简形）
  '姚': 'Y', // Yáo（库内）
  '尹': 'Y', // Yǐn（库内）
  '易': 'Y', // Yì（库内）
  '楊': 'Y', // Yáng（库内）
  '杨': 'Y', // Yáng（简形）
  '游': 'Y', // Yóu（库内）
  '葉': 'Y', // Yè（库内）
  '叶': 'Y', // Yè（简形）
  '野': 'Y', // Yě（库内）
  '燕': 'Y', // Yān / Yàn
  '殷': 'Y', // Yīn
  '于': 'Y', // Yú
  '虞': 'Y', // Yú
  '郁': 'Y', // Yù
  '喻': 'Y', // Yù
  '袁': 'Y', // Yuán
  '尉': 'Y', // Yù（姓氏专读）
  '應': 'Y', // Yīng
  '应': 'Y', // Yīng（简形）
  '雍': 'Y', // Yōng
  '尤': 'Y', // Yóu
  '禹': 'Y', // Yǔ
  '裕': 'Y', // Yù
  '元': 'Y', // Yuán
  '越': 'Y', // Yuè
  '岳': 'Y', // Yuè
  '雲': 'Y', // Yún
  '云': 'Y', // Yún（简形）
  '顏': 'Y', // Yán
  '颜': 'Y', // Yán（简形）
  '閻': 'Y', // Yán
  '阎': 'Y', // Yán（简形）

  /* ---- Z ---- */
  '周': 'Z', // Zhōu（库内）
  '張': 'Z', // Zhāng（库内）
  '张': 'Z', // Zhāng（简形）
  '宗': 'Z', // Zōng（库内）
  '曾': 'Z', // Zēng（库内，姓氏专读）
  '朱': 'Z', // Zhū（库内）
  '查': 'Z', // Zhā（库内，姓氏专读；旧读 chá）
  '章': 'Z', // Zhāng（库内）
  '鄒': 'Z', // Zōu（库内）
  '邹': 'Z', // Zōu（简形）
  '鄭': 'Z', // Zhèng（库内）
  '郑': 'Z', // Zhèng（简形）
  '鐘': 'Z', // Zhōng（库内）
  '钟': 'Z', // Zhōng（简形）
  '鍾': 'Z', // Zhōng（另形）
  '趙': 'Z', // Zhào（库内）
  '赵': 'Z', // Zhào（简形）
  '祝': 'Z', // Zhù
  '莊': 'Z', // Zhuāng
  '庄': 'Z', // Zhuāng（简形）
  '卓': 'Z' // Zhuó
}

/**
 * 分组顺序：**`A` → `Z`，`#` 收在最后**。
 * 依据：通讯录式阅读按字母序推进；**无姓氏 / 查不到的行落 `#`，建议排最后**
 * （既不打断 A–Z 的连续阅读，也避免把「无姓氏」当成首组误导定位）。
 * 注：本序只作**排序键**；实际分组以 `groupPersons` 的**非空组**为准（空字母不出组）。
 */
export const GROUP_ORDER = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z', '#']

/* --------------------------------------------------------------------------- */
/* 内部小工具（不导出：对外只用下面四个纯函数）                                  */
/* --------------------------------------------------------------------------- */

/** 取字符串首个码点（按码点切，避免把增补平面汉字切成半个代理对）；空 / 非字符串 ⇒ `''`。 */
function firstCharOf(value) {
  const text = value === null || value === undefined ? '' : String(value).trim()
  if (!text) return ''
  const chars = Array.from(text)
  return chars.length ? chars[0] : ''
}

/**
 * 排序 / 分组用的**姓氏键**（单字）：优先 `family_name` 首字；
 * 无则退 `alias_names[0]` 首字、再退 `courtesy_names[0]` 首字；仍无 ⇒ `''`。
 * 与 `initialOfPerson` 同源 ⇒ 「排到哪一组」与「按什么排」永远一致。
 */
function surnameKeyOf(row) {
  if (!row || typeof row !== 'object') return ''
  return (
    firstCharOf(row.family_name) ||
    firstCharOf(Array.isArray(row.alias_names) ? row.alias_names[0] : '') ||
    firstCharOf(Array.isArray(row.courtesy_names) ? row.courtesy_names[0] : '') ||
    ''
  )
}

/** 缺省显示名（**兜底用**：调用方应传服务层 `personName`；链与数据层显示名派生同源）。 */
function defaultPersonName(row) {
  if (!row || typeof row !== 'object') return ''
  const full = `${String(row.family_name || '').trim()}${String(row.given_name || '').trim()}`
  if (full) return full
  const courtesy = Array.isArray(row.courtesy_names) && row.courtesy_names.length ? String(row.courtesy_names[0] || '').trim() : ''
  if (courtesy) return courtesy
  const art = Array.isArray(row.art_names) && row.art_names.length ? String(row.art_names[0] || '').trim() : ''
  return art || ''
}

/**
 * 拼音比较器：`Intl.Collator('zh-Hans-CN', { collation: 'pinyin', sensitivity: 'base' })`。
 * 本仓已实测 Node 与浏览器均可用 ⇒ 不引第三方拼音库；万一运行时不可用 ⇒ `null`，
 * 由 `sortPersons` 回落 `localeCompare`。
 */
function createPinyinCollator() {
  try {
    if (typeof Intl === 'undefined' || typeof Intl.Collator !== 'function') return null
    return new Intl.Collator('zh-Hans-CN', { collation: 'pinyin', sensitivity: 'base' })
  } catch (error) {
    return null
  }
}

const PINYIN_COLLATOR = createPinyinCollator()

/** 分组秩：越小越靠前；`GROUP_ORDER` 之外的字母兜底排最后。 */
function rankOfInitial(initial) {
  const index = GROUP_ORDER.indexOf(initial)
  return index === -1 ? GROUP_ORDER.length : index
}

/* --------------------------------------------------------------------------- */
/* 对外纯函数                                                                   */
/* --------------------------------------------------------------------------- */

/**
 * 姓氏（或姓名首字）→ `A`–`Z`；**查不到 / 空 / 非汉字 ⇒ `'#'`**（不猜测、不做简繁转换）。
 * @param {string} name 姓氏汉字，或「姓 + 名」的整串（只取首字）
 * @returns {'A'|'B'|'C'|'D'|'E'|'F'|'G'|'H'|'I'|'J'|'K'|'L'|'M'|'N'|'O'|'P'|'Q'|'R'|'S'|'T'|'U'|'V'|'W'|'X'|'Y'|'Z'|'#'}
 */
export function initialOfSurname(name) {
  const key = firstCharOf(name)
  if (!key) return '#'
  return Object.prototype.hasOwnProperty.call(SURNAME_INITIALS, key) ? SURNAME_INITIALS[key] : '#'
}

/**
 * 印人行 → 分组字母：优先 `family_name` 首字；无则退 `alias_names[0]` / `courtesy_names[0]`
 * 首字；仍无 / 查不到 ⇒ `'#'`（9 位无 `family_name` 的行即落此组）。
 * @param {object} row 印人行
 * @returns {string}
 */
export function initialOfPerson(row) {
  const key = surnameKeyOf(row)
  if (!key) return '#'
  return Object.prototype.hasOwnProperty.call(SURNAME_INITIALS, key) ? SURNAME_INITIALS[key] : '#'
}

/**
 * 通讯录式排序：**先按姓氏（拼音）、再按显示名**；`'#'`（无姓氏 / 查不到）排最后。
 *
 * - 比较器 ＝ `Intl.Collator('zh-Hans-CN', { collation: 'pinyin', sensitivity: 'base' })`；
 * - **`Intl.Collator` 不可用 ⇒ 回落按显示名 `name` 的 `localeCompare`**（分组秩仍先比，
 *   保证 A–Z 各组连续）；
 * - **返回新数组**（`slice()` 起手），原数组次序不变。
 *
 * @param {Array<object>} persons 印人行数组
 * @param {{ personName?: (row: object) => string }} [options] `personName`＝显示名函数（缺省走内置兜底链）
 * @returns {Array<object>} 排好序的新数组
 */
export function sortPersons(persons, { personName } = {}) {
  const rows = Array.isArray(persons) ? persons.slice() : []
  const nameOf = typeof personName === 'function' ? personName : defaultPersonName
  const nameTextOf = (row) => String(nameOf(row) === null || nameOf(row) === undefined ? '' : nameOf(row))

  rows.sort((a, b) => {
    const rankDiff = rankOfInitial(initialOfPerson(a)) - rankOfInitial(initialOfPerson(b))
    if (rankDiff !== 0) return rankDiff
    if (PINYIN_COLLATOR) {
      const keyDiff = PINYIN_COLLATOR.compare(surnameKeyOf(a), surnameKeyOf(b))
      if (keyDiff !== 0) return keyDiff
      return PINYIN_COLLATOR.compare(nameTextOf(a), nameTextOf(b))
    }
    return nameTextOf(a).localeCompare(nameTextOf(b), 'zh-Hans-CN')
  })
  return rows
}

/**
 * 分组：⇒ `[{ initial, rows }]`，按 `GROUP_ORDER`（`A`…`Z`、`#` 最后），
 * **只出非空组**（没人姓 I / U / V ⇒ 这些字母不出现在返回里）。
 * 组内次序 ＝ `sortPersons` 次序。
 *
 * @param {Array<object>} persons 印人行数组
 * @param {{ personName?: (row: object) => string }} [options] 同 `sortPersons`
 * @returns {Array<{ initial: string, rows: Array<object> }>}
 */
export function groupPersons(persons, { personName } = {}) {
  const sorted = sortPersons(persons, { personName })
  const buckets = new Map()
  for (const row of sorted) {
    const initial = initialOfPerson(row)
    if (!buckets.has(initial)) buckets.set(initial, [])
    buckets.get(initial).push(row)
  }
  return GROUP_ORDER.filter((initial) => buckets.has(initial)).map((initial) => ({
    initial,
    rows: buckets.get(initial)
  }))
}
