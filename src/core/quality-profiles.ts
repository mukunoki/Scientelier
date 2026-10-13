import { createHash } from "node:crypto";
import type { TaskRecord, WorkUnit } from "./types";
import type { QualityContext, QualitySpec } from "./quality";

// These are applicability/verification contracts, not a second copy of editable
// mode rules. Detailed procedures continue to come from presets and work skills.
const profiles: Record<string, Array<[string,string,string,boolean]>> = {
  "paper-explainer": [
    ["foundations","前提知識と説明の接続","ユーザーが選んだ説明レベルから、未定義の用語・記号・説明の飛躍なく積み上げる。",false],
    ["fidelity","原論文・補足の忠実性","原論文の主張と背景の補足・比喩・説明用データを区別し、版とページ/節を独立照合する。",false],
    ["reader","読者視点・図解の理解確認","独立した読者役の具体的な指摘と修正証拠を確認する。口頭補足に依存せず全段階をPDFで読める。",false]
  ],
  idea: [
    ["alternatives","異なる候補と反証条件","異なる方法を比較し、採否と残る不確実性を証拠に結び付ける。",false],
    ["pilot","予備評価・反証実験","承認範囲で候補を識別する小さな検証を行う。実験不要の課題は理由と代替根拠を示す。",true]
  ],
  research: [
    ["coverage","調査範囲・重要研究の欠落","検索方針・期間・採否・反対の知見・探索限界を確認する。",false],
    ["sources","原典・書誌・紹介内容","一次資料の版と該当箇所を保存し、主張と紹介内容を照合する。著者を省略しない。",false]
  ],
  coding: [
    ["acceptance","要求への適合・異常系","対象要件に対応する正常・境界・異常系を検査し、未実行を区別する。",false],
    ["regression","回帰・互換性","変更前の基準と変更後の検査結果を照合する。性能向上や新規性はゴールにある場合だけ要求する。",false]
  ],
  paper: [
    ["claims","主張と証拠・論旨","方法・結果・解釈を区別し、説明の順序、節の接続、重複、結論の射程を確認する。",false],
    ["literature","関連研究との整合","引用と一次資料の意味を照合する。文献紹介が不要な原稿は根拠付きで対象外とする。",true]
  ],
  poster: [
    ["message","中心メッセージ・読む順序","主張を絞り、図・説明・結論の読む順序を確認する。",false],
    ["fidelity","情報の省略による誤解","短縮した説明でも比較条件・単位・出典・留保を維持する。",false]
  ],
  "hpc-refactoring": [], // Numerical/job gates remain in the existing HPC ledger.
  "research-project": [], // The composed modes and research ledger own their checks.
  general: [["acceptance","要求と成果物","承認済みの要求に対して成果物と確認方法を対応付ける。",false]]
};

export function qualitySpecs(task: TaskRecord, domain: "work"|"report"): QualitySpec[] {
  if(domain==="report") return [
    {id:"report-document",stage:"report",title:"文書・PDFの仕上げ",required:true,allowNA:false,guidance:"全成果物の構成・説明順序・PDFの表示を確認する。ポスター/スライドは実寸・文字サイズ・読む順序・はみ出しも確認する。"},
    {id:"report-numbers",stage:"report",title:"数値・図表と元データ",required:true,allowNA:true,guidance:"対象のセル・系列・実験IDを照合する。丸め・単位・許容差を明示し、数値や図表がない場合だけ根拠付きで対象外とする。"},
    {id:"report-references",stage:"report",title:"引用・一次資料・著者情報",required:true,allowNA:true,guidance:"一次資料から書誌と紹介内容を照合する。既存の異なるAIによる二重確認規約を維持する。引用不要の場合は理由を示す。"}
  ];
  const modes=task.workPreset?.stages?.map(p=>p.manifest.id) ?? [task.workPreset?.manifest.id ?? "general"];
  return modes.flatMap(stage=>[
    {id:`${stage}-scope`,stage,title:"作業範囲・証拠・未確認事項",required:true,allowNA:false,guidance:"ゴール・禁止事項との適合、成果物と根拠、未確認範囲を点検する。必須要件の対象外扱いや無断緩和は不可。"},
    ...(profiles[stage]??profiles.general).map(([key,title,guidance,allowNA])=>({id:`${stage}-${key}`,stage,title,guidance,allowNA,required:true}))
  ]);
}

export function qualityContext(task: TaskRecord, root: string, domain: "work"|"report", unit?: WorkUnit): QualityContext {
  const specs=qualitySpecs(task,domain);
  // Freeze requirements/instructions, not the round counter. Unchanged evidence
  // can survive a retry; a changed goal or instruction must be checked again.
  const changesDomain=(kind:string)=>!["consult","review",...(domain==="work"?["report"]:[])].includes(kind);
  const instruction=changesDomain(task.roundKind??"initial") ? task.instruction??task.prompt
    : [...(task.history??[])].reverse().find(r=>changesDomain(r.kind))?.instruction??task.prompt;
  const contract=createHash("sha256").update(JSON.stringify({version:1,goal:task.goal,prompt:task.prompt,instruction,preset:task.workPreset})).digest("hex");
  const stage=domain==="report"?"report":unit?.researchStage;
  return {root,taskId:task.id,domain,contract,specs,actor:unit?.id??"harness",write:!!unit && unit.mode==="write" && !unit.planPhase && unit.role!=="reviewer",
    manage:!!unit && (!!unit.primary || !!unit.planPhase || unit.role==="planner" || unit.role==="reporter"),
    allowedStages:stage?[stage]:[...new Set(specs.map(s=>s.stage))],criterionIds:task.goal?.criteria.map(c=>c.id)??[],user:!unit};
}

export function qualityEnabled(task: TaskRecord): boolean {return !!task.qualityCycle && task.goal?.status==="approved" && !task.goalPreparation && task.roundKind!=="consult";}
