// ============================================================
// VGC ダメージ計算エンジン（ポケモンチャンピオンズ準拠 / Lv50固定）
// 実数値: HP=種族値+SP+75 / 他=floor((種族値+SP+20.5)×性格)
// ダメージ: floor(floor(22×威力×A/D)/50)+2 → 補正チェーン(4096ベース,本家準拠順)
// window.CALC として公開。データ(種族値/技)は呼び出し側が渡す。
// ============================================================
(function(){
'use strict';

// ---- タイプ相性（第9世代準拠 18タイプ）: EFF[攻][受] 省略時1 ----
const X = {
  Normal:{Rock:.5,Ghost:0,Steel:.5},
  Fire:{Fire:.5,Water:.5,Grass:2,Ice:2,Bug:2,Rock:.5,Dragon:.5,Steel:2},
  Water:{Fire:2,Water:.5,Grass:.5,Ground:2,Rock:2,Dragon:.5},
  Electric:{Water:2,Electric:.5,Grass:.5,Ground:0,Flying:2,Dragon:.5},
  Grass:{Fire:.5,Water:2,Grass:.5,Poison:.5,Ground:2,Flying:.5,Bug:.5,Rock:2,Dragon:.5,Steel:.5},
  Ice:{Fire:.5,Water:.5,Grass:2,Ice:.5,Ground:2,Flying:2,Dragon:2,Steel:.5},
  Fighting:{Normal:2,Ice:2,Poison:.5,Flying:.5,Psychic:.5,Bug:.5,Rock:2,Ghost:0,Dark:2,Steel:2,Fairy:.5},
  Poison:{Grass:2,Poison:.5,Ground:.5,Rock:.5,Ghost:.5,Steel:0,Fairy:2},
  Ground:{Fire:2,Electric:2,Grass:.5,Poison:2,Flying:0,Bug:.5,Rock:2,Steel:2},
  Flying:{Electric:.5,Grass:2,Fighting:2,Bug:2,Rock:.5,Steel:.5},
  Psychic:{Fighting:2,Poison:2,Psychic:.5,Dark:0,Steel:.5},
  Bug:{Fire:.5,Grass:2,Fighting:.5,Poison:.5,Flying:.5,Psychic:2,Ghost:.5,Dark:2,Steel:.5,Fairy:.5},
  Rock:{Fire:2,Ice:2,Fighting:.5,Ground:.5,Flying:2,Bug:2,Steel:.5},
  Ghost:{Normal:0,Psychic:2,Ghost:2,Dark:.5},
  Dragon:{Dragon:2,Steel:.5,Fairy:0},
  Dark:{Fighting:.5,Psychic:2,Ghost:2,Dark:.5,Fairy:.5},
  Steel:{Fire:.5,Water:.5,Electric:.5,Ice:2,Rock:2,Steel:.5,Fairy:2},
  Fairy:{Fire:.5,Fighting:2,Poison:.5,Dragon:2,Dark:2,Steel:.5}
};
const effOf=(t,def)=>def.reduce((m,d)=>m*((X[t]||{})[d]??1),1);

// ---- 丸め・チェーン（本家準拠） ----
const pokeRound=v=>{ const f=Math.floor(v); return (v-f>0.5)? f+1:f; };           // 0.5は切り捨て
const chain=(mods)=>mods.reduce((m,x)=>((m*x+2048)>>12),4096);                    // 4096ベース連鎖
const applyMod=(v,m)=>(m===4096? v : Math.max(1,pokeRound(v*m/4096)));

// ---- ランク補正 ----
const rankMul=(st,r)=>{ r=r|0; return r>=0? Math.floor(st*(2+r)/2) : Math.floor(st*2/(2-r)); };

// ---- 特性・アイテム判定ヘルパ ----
const has=(fl,f)=>!!(fl&&fl.includes(f));
const MOLD=['かたやぶり','ターボブレイズ','テラボルテージ'];
const TYPE_BOOST_ITEM={ 'しんぴのしずく':'Water','もくたん':'Fire','じしゃく':'Electric','くろいメガネ':'Dark','シルクのスカーフ':'Normal',
  'するどいくちばし':'Flying','どくバリ':'Poison','やわらかいすな':'Ground','かたいいし':'Rock','ぎんのこな':'Bug','のろいのおふだ':'Ghost',
  'りゅうのキバ':'Dragon','メタルコート':'Steel','まがったスプーン':'Psychic','きせきのタネ':'Grass','とけないこおり':'Ice','くろおび':'Fighting','ようせいのハネ':'Fairy' };
const RESIST_BERRY={ 'オッカのみ (ほのお半減)':'Fire','イトケのみ (みず半減)':'Water','ソクノのみ (でんき半減)':'Electric','リンドのみ (くさ半減)':'Grass',
  'ヤチェのみ (こおり半減)':'Ice','ヨプのみ (かくとう半減)':'Fighting','ビアーのみ (どく半減)':'Poison','シュカのみ (じめん半減)':'Ground',
  'バコウのみ (ひこう半減)':'Flying','ウタンのみ (エスパー半減)':'Psychic','タンガのみ (むし半減)':'Bug','ヨロギのみ (いわ半減)':'Rock',
  'カシブのみ (ゴースト半減)':'Ghost','ナモのみ (あく半減)':'Dark','リリバのみ (はがね半減)':'Steel','ハバンのみ (ドラゴン半減)':'Dragon',
  'ホズのみ (ノーマル半減)':'Normal','ロゼルのみ (フェアリー半減)':'Fairy' };

function grounded(side){ // 浮いているか（タイプ/特性/風船の簡易判定）
  if(side.item==='ふうせん') return false;
  if(side.ability==='ふゆう') return false;
  return !(side.types||[]).includes('Flying');
}

// ============================================================
// メイン計算
// in: {
//   move: {en, ja, t, c(1物理/2特殊), p, fl, sc, rc, mh, cr},
//   atk:  {stats:[H,A,B,C,D,S], types:[], ability, item, status(''/'やけど'/'どく'等),
//          rank:{a,c}, pinch(1/3以下), flash(もらいび発動), boost(パラドックス発動), fainted(そうだいしょう数), weight},
//   def:  {stats, types, ability, item, rank:{b,d}, hpFull, boost, weight},
//   field:{weather(''/'sun'/'rain'/'sand'/'snow'), terrain(''/'electric'/'grassy'/'psychic'/'misty'),
//          doubles, spread(対象2体以上), screen(壁あり), crit, helpingHand, auraBreak}
// }
// out: {rolls[16], min,max, minPct,maxPct, eff, ko:{n,prob,text}, immune:理由|null, moveType}
// ============================================================
function calc(input){
  const mv=input.move, atk=input.atk, def=input.def, F=input.field||{};
  if(!mv || mv.c===0) return null;                       // 変化技
  const moldBreaks = MOLD.includes(atk.ability);
  const defAb = moldBreaks? '' : (def.ability||'');
  const W=F.weather||'', T=F.terrain||'';

  // ---- 技タイプ（スキン系変換） ----
  let type=mv.t, skinBoost=false;
  const SKIN={'フェアリースキン':'Fairy','エレキスキン':'Electric','スカイスキン':'Flying','フリーズスキン':'Ice'};
  if(type==='Normal' && SKIN[atk.ability]){ type=SKIN[atk.ability]; skinBoost=true; }
  else if(atk.ability==='ノーマルスキン' && type!=='Normal'){ type='Normal'; skinBoost=true; }

  // ---- 無効化（防御側特性・アイテム・タイプ） ----
  const IMMUNE_AB={ 'ふゆう':['Ground'],'ちょすい':['Water'],'よびみず':['Water'],'ちくでん':['Electric'],'ひらいしん':['Electric'],
    'でんきエンジン':['Electric'],'もらいび':['Fire'],'そうしょく':['Grass'],'どしょく':['Ground'],'かんそうはだ':['Water'],'こんがりボディ':['Fire'] };
  if((IMMUNE_AB[defAb]||[]).includes(type)) return {immune:'特性 '+defAb+' で無効', moveType:type};
  if(defAb==='ぼうおん' && has(mv.fl,'sound')) return {immune:'ぼうおんで無効', moveType:type};
  if(defAb==='ぼうだん' && has(mv.fl,'bullet')) return {immune:'ぼうだんで無効', moveType:type};
  if(defAb==='かぜのり' && has(mv.fl,'wind')) return {immune:'かぜのりで無効', moveType:type};
  if(type==='Ground' && def.item==='ふうせん') return {immune:'ふうせんで無効', moveType:type};
  if(type==='Ground' && !grounded(def) && !(def.types||[]).includes('Flying')) return {immune:'接地していない（ふゆう等）', moveType:type};

  // ---- タイプ相性 ----
  let defTypes=def.types||[];
  let eff=effOf(type,defTypes);
  // しんがん/きもったま: ノーマル・かくとう→ゴーストに等倍
  if(eff===0 && ['しんがん','きもったま'].includes(atk.ability) && (type==='Normal'||type==='Fighting') && defTypes.includes('Ghost')){
    eff=effOf(type,defTypes.filter(t=>t!=='Ghost'))||1;
  }
  if(eff===0) return {immune:'タイプ相性で無効', eff:0, moveType:type};

  // ---- 威力（基本威力の可変技 → 4096チェーン） ----
  let bp=mv.p||0;
  const en=mv.en;
  if(en==='Acrobatics' && !atk.item) bp*=2;
  if(en==='Facade' && atk.status) bp*=2;
  if(['Grass Knot','Low Kick'].includes(en)){ const w=def.weight||0; bp = w>=200?120 : w>=100?100 : w>=50?80 : w>=25?60 : w>=10?40 : 20; }
  if(['Heavy Slam','Heat Crash'].includes(en)){ const r=(atk.weight||1)/(def.weight||1); bp = r>=5?120 : r>=4?100 : r>=3?80 : r>=2?60 : 40; }
  if(en==='Gyro Ball'){ bp=Math.min(150, Math.floor(25*(def.stats[5])/Math.max(1,atk.stats[5]))+1); }
  if(en==='Electro Ball'){ const r=atk.stats[5]/Math.max(1,def.stats[5]); bp = r>=4?150 : r>=3?120 : r>=2?80 : r>=1?60 : 40; }
  if(bp<=0) return null;

  const bpMods=[];
  // 場・オーラ
  if(F.helpingHand) bpMods.push(6144);
  if(T==='electric' && type==='Electric' && grounded(atk)) bpMods.push(5325);
  if(T==='grassy' && type==='Grass' && grounded(atk)) bpMods.push(5325);
  if(T==='psychic' && type==='Psychic' && grounded(atk)) bpMods.push(5325);
  if(T==='misty' && type==='Dragon' && grounded(def)) bpMods.push(2048);
  if(T==='grassy' && ['Earthquake','Bulldoze','Magnitude'].includes(en)) bpMods.push(2048);
  const aura=(type==='Fairy'&&(atk.ability==='フェアリーオーラ'||def.ability==='フェアリーオーラ'))||(type==='Dark'&&(atk.ability==='ダークオーラ'||def.ability==='ダークオーラ'));
  if(aura) bpMods.push(F.auraBreak?3072:5448);
  // 攻撃側特性（威力系）
  const A=atk.ability;
  if(skinBoost) bpMods.push(4915);
  if(A==='テクニシャン' && bp<=60) bpMods.push(6144);
  if(A==='アイアンフィスト' && has(mv.fl,'punch')) bpMods.push(4915);
  if(A==='かたいツメ' && has(mv.fl,'contact')) bpMods.push(5325);
  if(A==='すてみ' && mv.rc) bpMods.push(4915);
  if(A==='ちからずく' && mv.sc) bpMods.push(5325);
  if(A==='アナライズ' && atk.analytic) bpMods.push(5325);
  if(A==='パンクロック' && has(mv.fl,'sound')) bpMods.push(5325);
  if(A==='メガランチャー' && has(mv.fl,'pulse')) bpMods.push(6144);
  if(A==='きれあじ' && has(mv.fl,'slicing')) bpMods.push(6144);
  if(A==='つよいあご' && has(mv.fl,'bite')) bpMods.push(6144);
  if(A==='とうそうしん' && atk.rivalry===1) bpMods.push(5120);
  if(A==='とうそうしん' && atk.rivalry===-1) bpMods.push(3072);
  if(A==='すなのちから' && W==='sand' && ['Ground','Rock','Steel'].includes(type)) bpMods.push(5325);
  if(A==='いわはこび' && type==='Rock') bpMods.push(6144);
  if(['はがねつかい','はがねのせいしん'].includes(A) && type==='Steel') bpMods.push(6144);
  if(A==='トランジスタ' && type==='Electric') bpMods.push(5325);
  if(A==='りゅうのあぎと' && type==='Dragon') bpMods.push(6144);
  if(A==='そうだいしょう' && atk.fainted) bpMods.push(4096+410*Math.min(5,atk.fainted));
  if(A==='ねつぼうそう' && atk.status==='やけど' && mv.c===2) bpMods.push(6144);
  if(A==='どくぼうそう' && (atk.status==='どく'||atk.status==='もうどく') && mv.c===1) bpMods.push(6144);
  const PINCH={'しんりょく':'Grass','もうか':'Fire','げきりゅう':'Water','むしのしらせ':'Bug'};
  if(PINCH[A]===type && atk.pinch) bpMods.push(6144);
  if(A==='もらいび' && atk.flash && type==='Fire') bpMods.push(6144);
  if(A==='すいほう' && type==='Water') bpMods.push(8192);
  // 防御側特性（威力系）
  if(defAb==='たいねつ' && type==='Fire') bpMods.push(2048);
  if(defAb==='かんそうはだ' && type==='Fire') bpMods.push(5120);
  // アイテム（威力系）
  if(TYPE_BOOST_ITEM[atk.item]===type) bpMods.push(4915);
  bp=Math.max(1,pokeRound(bp*chain(bpMods)/4096));

  // ---- 攻撃実数値 ----
  let phys = mv.c===1;
  let atkStat, atkRank;
  if(en==='Body Press'){ atkStat=atk.stats[2]; atkRank=(atk.rank&&atk.rank.b)||0; }
  else if(en==='Foul Play'){ atkStat=def.stats[1]; atkRank=(def.rank&&def.rank.a)||0; }
  else { atkStat=phys? atk.stats[1]:atk.stats[3]; atkRank=phys? ((atk.rank&&atk.rank.a)||0):((atk.rank&&atk.rank.c)||0); }
  if(F.crit) atkRank=Math.max(0,atkRank);              // 急所はマイナスランク無視
  atkStat=rankMul(atkStat,atkRank);
  const aMods=[];
  if(['ちからもち','ヨガパワー'].includes(A) && phys) aMods.push(8192);
  if(A==='はりきり' && phys) aMods.push(6144);
  if(A==='こんじょう' && atk.status && phys) aMods.push(6144);
  if(A==='ごりむちゅう' && phys) aMods.push(6144);
  if(A==='サンパワー' && W==='sun' && !phys) aMods.push(6144);
  if(A==='ひひいろのこどう' && W==='sun' && phys) aMods.push(5461);
  if(A==='ハドロンエンジン' && T==='electric' && !phys) aMods.push(5461);
  if(A==='フラワーギフト' && W==='sun' && phys) aMods.push(6144);
  if(A==='スロースタート' && atk.slowstart && phys) aMods.push(2048);
  if(A==='よわき' && atk.pinchHalf) aMods.push(2048);
  if(['こだいかっせい','クォークチャージ'].includes(A) && atk.boost){
    const hi=[1,2,3,4,5].reduce((m,i)=>atk.stats[i]>atk.stats[m]?i:m,1);
    if((phys&&hi===1)||(!phys&&hi===3)) aMods.push(5325);
  }
  if(defAb==='あついしぼう' && ['Fire','Ice'].includes(type)) aMods.push(2048);
  if(defAb==='きよめのしお' && type==='Ghost') aMods.push(2048);
  if(atk.item==='こだわりハチマキ' && phys) aMods.push(6144);
  if(atk.item==='こだわりメガネ' && !phys) aMods.push(6144);
  if(atk.item==='でんきだま' && atk.isPikachu) aMods.push(8192);
  atkStat=applyMod(atkStat,chain(aMods));

  // ---- 防御実数値 ----
  const useB = phys || ['Psyshock','Psystrike','Secret Sword'].includes(en);
  let defStat=useB? def.stats[2]:def.stats[4];
  let defRank=useB? ((def.rank&&def.rank.b)||0):((def.rank&&def.rank.d)||0);
  if(F.crit) defRank=Math.min(0,defRank);              // 急所はプラスランク無視
  if(en==='Sacred Sword'||en==='Darkest Lariat') defRank=0;
  defStat=rankMul(defStat,defRank);
  const dMods=[];
  if(W==='sand' && (def.types||[]).includes('Rock') && !useB) dMods.push(6144);
  if(W==='snow' && (def.types||[]).includes('Ice') && useB) dMods.push(6144);
  if(defAb==='ファーコート' && useB) dMods.push(8192);
  if(defAb==='くさのけがわ' && T==='grassy' && useB) dMods.push(6144);
  if(defAb==='フラワーギフト' && W==='sun' && !useB) dMods.push(6144);
  if(['こだいかっせい','クォークチャージ'].includes(defAb) && def.boost){
    const hi=[1,2,3,4,5].reduce((m,i)=>def.stats[i]>def.stats[m]?i:m,1);
    if((useB&&hi===2)||(!useB&&hi===4)) dMods.push(5325);
  }
  if(def.item==='とつげきチョッキ' && !useB) dMods.push(6144);
  if(def.item==='しんかのきせき') dMods.push(6144);
  defStat=applyMod(defStat,chain(dMods));

  // ---- 基礎ダメージ（Lv50 → 22） ----
  let base=Math.floor(Math.floor(22*bp*atkStat/defStat)/50)+2;

  // ---- 補正チェーン（本家準拠順） ----
  if(F.spread && F.doubles) base=pokeRound(base*3072/4096);
  if(W==='sun') base= type==='Fire'? pokeRound(base*6144/4096) : type==='Water'? pokeRound(base*2048/4096) : base;
  if(W==='rain') base= type==='Water'? pokeRound(base*6144/4096) : type==='Fire'? pokeRound(base*2048/4096) : base;
  if(F.crit) base=Math.floor(base*1.5);

  // STAB
  let stab=4096;
  if((atk.types||[]).includes(type)) stab= A==='てきおうりょく'? 8192:6144;
  else if(A==='へんげんじざい'||A==='リベロ') stab=6144;

  // 最終補正
  const fin=[];
  if(F.screen && !F.crit && A!=='すりぬけ') fin.push(F.doubles?2732:2048);
  if(defAb==='マルチスケイル'||defAb==='ファントムガード'){ if(def.hpFull!==false) fin.push(2048); }
  if(['フィルター','ハードロック','プリズムアーマー'].includes(defAb) && eff>1) fin.push(3072);
  if(defAb==='もふもふ'){ if(has(mv.fl,'contact')) fin.push(2048); if(type==='Fire') fin.push(8192); }
  if(defAb==='こおりのりんぷん' && !phys) fin.push(2048);
  if(defAb==='すいほう' && type==='Fire') fin.push(2048);
  if(F.friendGuard) fin.push(3072);
  if(A==='スナイパー' && F.crit) fin.push(6144);
  if(A==='いろめがね' && eff<1) fin.push(8192);
  if(atk.item==='たつじんのおび' && eff>1) fin.push(4915);
  if(atk.item==='いのちのたま') fin.push(5324);
  if(RESIST_BERRY[def.item]===type && (eff>1 || type==='Normal')) fin.push(2048);
  const finMod=chain(fin);

  // ---- 乱数16通り ----
  const burn = atk.status==='やけど' && phys && A!=='こんじょう' && en!=='Facade';
  const hits = mv.mh? (String(mv.mh).includes('[')? (A==='スキルリンク'?5: null) : parseInt(mv.mh)) : 1; // 連続技: 固定回数 or スキルリンク5, 可変は期待しない場合 null→3回想定
  const nHits = hits || (mv.mh? 3:1);
  const rolls=[];
  for(let i=0;i<16;i++){
    let d=Math.floor(base*(85+i)/100);
    d=pokeRound(d*stab/4096);
    d=Math.floor(d*eff);
    if(burn) d=Math.floor(d/2);
    d=Math.max(1,pokeRound(d*finMod/4096));
    rolls.push(d*nHits);
  }
  const hp=def.stats[0];
  const min=rolls[0], max=rolls[15];
  const minPct=Math.round(min/hp*1000)/10, maxPct=Math.round(max/hp*1000)/10;

  // ---- 確定数（16乱数一様と仮定した正確な確率） ----
  const nMin=Math.ceil(hp/max), nMax=Math.ceil(hp/min); // 最短/最長発数
  let ko;
  if(nMin===nMax) ko={n:nMax, prob:1, text:'確定'+nMax+'発'};
  else {
    // nMin発でKOできる確率をDPで算出
    let dist={0:1};
    for(let h=0;h<nMin;h++){ const nd={};
      for(const s in dist) for(const r of rolls){ const k=Math.min(hp,+s+r); nd[k]=(nd[k]||0)+dist[s]/16; }
      dist=nd; }
    const p=dist[hp]||0;
    ko={n:nMin, prob:p, text:'乱数'+nMin+'発 ('+(Math.round(p*1000)/10)+'%)'};
  }
  return {rolls,min,max,minPct,maxPct,eff,ko,immune:null,moveType:type,nHits};
}

// ---- 素早さ実効値 ----
function speedOf(sBase, o){ // sBase=実数値S, o={rank,scarf,tailwind,para, swift(すいすい等発動)}
  o=o||{}; let s=rankMul(sBase,o.rank||0);
  if(o.scarf) s=Math.floor(s*1.5);
  if(o.swift) s*=2;
  if(o.tailwind) s*=2;
  if(o.para) s=Math.floor(s*0.5);
  return s;
}

window.CALC={calc, speedOf, effOf, X};
})();
