import { useState, useCallback, useMemo } from "react";
import {
  ScatterChart, Scatter, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer,
} from "recharts";

/* ── Price fetch (Yahoo v8/chart — the ONLY endpoint that works from browser) ── */
async function fetchPrice(ticker) {
  const url = `https://corsproxy.io/?${encodeURIComponent(
    `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1d`
  )}`;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url);
      if (!r.ok) { await new Promise(ok => setTimeout(ok, 700)); continue; }
      const d = await r.json();
      const m = d?.chart?.result?.[0]?.meta;
      if (!m?.regularMarketPrice) continue;
      return {
        price: parseFloat(m.regularMarketPrice.toFixed(2)),
        name: m.longName || m.shortName || ticker,
        symbol: m.symbol || ticker,
        date: new Date(m.regularMarketTime * 1000).toLocaleDateString(),
      };
    } catch (_) { await new Promise(ok => setTimeout(ok, 700)); }
  }
  return null;
}

function guessSector(t) {
  const S = {
    Tech:['AAPL','MSFT','GOOGL','GOOG','META','NVDA','AMD','INTC','AVGO','QCOM','TXN','ADBE','CRM','ORCL','CSCO','NFLX','TSLA','NOW','PLTR','SNOW','DDOG','NET','CRWD','ZS','PANW','FTNT','OKTA','MDB','TEAM','WDAY','ZM','DOCU'],
    Finance:['JPM','BAC','WFC','GS','MS','C','BLK','SCHW','USB','PNC','TFC','AXP','V','MA','PYPL','SQ','COIN','BX','KKR','SPGI','MCO'],
    Health:['JNJ','UNH','PFE','ABT','TMO','MRK','DHR','LLY','ABBV','BMY','AMGN','GILD','CVS','CI','VRTX','REGN','ISRG','BIIB','ILMN','ZTS'],
    Retail:['AMZN','WMT','HD','TGT','COST','LOW','NKE','SBUX','MCD','DIS','BKNG','SHOP','MELI','EBAY','ETSY'],
    Energy:['XOM','CVX','COP','SLB','EOG','PXD','MPC','PSX','VLO','OXY','HAL'],
    Industrials:['BA','CAT','GE','HON','UPS','RTX','LMT','DE','MMM','UNP','NSC','CSX','FDX','WM','EMR'],
    Semis:['NVDA','AMD','INTC','AVGO','QCOM','TXN','MU','AMAT','LRCX','KLAC','ASML','TSM','ADI','MRVL','NXPI'],
    Staples:['PG','KO','PEP','WMT','COST','CL','MDLZ','GIS','KHC','STZ'],
    Materials:['LIN','APD','ECL','SHW','NEM','FCX','NUE','VMC','MLM'],
    REIT:['AMT','PLD','CCI','EQIX','PSA','O','WELL','DLR','SPG','VICI'],
  };
  for (const [sec, arr] of Object.entries(S)) if (arr.includes(t)) return sec;
  return "Other";
}

/* ── Monte Carlo ── */
const RF = 0.04;
class RNG{constructor(s){this.s=s;}next(){this.s=(this.s*1103515245+12345)&0x7fffffff;return this.s/0x7fffffff;}}
function synReturns(n,days,seed){const g=new RNG(seed),r=[];for(let d=0;d<days;d++){const row=[];for(let i=0;i<n;i++){const u1=Math.max(1e-4,g.next()),u2=g.next();row.push(.0004+Math.sqrt(-2*Math.log(u1))*Math.cos(2*Math.PI*u2)*.02);}r.push(row);}return r;}
function calcMu(r){const n=r[0].length,d=r.length,m=Array(n).fill(0);r.forEach(row=>row.forEach((v,i)=>{m[i]+=v;}));return m.map(v=>(v/d)*252);}
function calcCov(r){const n=r[0].length,d=r.length;const mu=r[0].map((_,i)=>r.reduce((s,row)=>s+row[i],0)/d);const c=Array.from({length:n},()=>Array(n).fill(0));for(let i=0;i<n;i++)for(let j=0;j<n;j++){let s=0;r.forEach(row=>{s+=(row[i]-mu[i])*(row[j]-mu[j]);});c[i][j]=(s/(d-1))*252;}return c;}
function portStats(w,mu,cov){const ret=w.reduce((s,wi,i)=>s+wi*mu[i],0);let v=0;for(let i=0;i<w.length;i++)for(let j=0;j<w.length;j++)v+=w[i]*w[j]*cov[i][j];const vol=Math.sqrt(Math.max(v,1e-6));return{ret,vol,sharpe:(ret-RF)/vol};}
function randWeights(n,g){const w=Array.from({length:n},()=>g.next());const s=w.reduce((a,b)=>a+b,0);return w.map(v=>v/s);}
function optimize(tickers,iter=8000){const n=tickers.length;const seed=tickers.reduce((s,t,i)=>s+t.charCodeAt(0)*31*(i+1)+(t.charCodeAt(t.length-1)||0),42);const ret=synReturns(n,504,seed);const mu=calcMu(ret),cov=calcCov(ret);const g1=new RNG(seed+1),g2=new RNG(seed+9999);let bMV={vol:Infinity},bMS={sharpe:-Infinity};const fr=[],allSh=[],allMVR=[],allMSR=[];for(let i=0;i<iter;i++){const w1=randWeights(n,g1),s1=portStats(w1,mu,cov);if(s1.vol<bMV.vol)bMV={weights:[...w1],...s1};allMVR.push(s1.ret);const w2=randWeights(n,g2),s2=portStats(w2,mu,cov);if(s2.sharpe>bMS.sharpe)bMS={weights:[...w2],...s2};allMSR.push(s2.ret);allSh.push(s2.sharpe);if(i%10===0)fr.push({x:+(s2.vol*100).toFixed(3),y:+(s2.ret*100).toFixed(3)});}const avg=a=>a.reduce((s,v)=>s+v,0)/a.length;return{minVar:bMV,maxSharpe:bMS,frontier:fr,avgMSR:avg(allMSR),avgMVR:avg(allMVR),avgSh:avg(allSh)};}

/* ── Styles ── */
const SEC_CLR={Tech:'#6366f1',Semis:'#8b5cf6',Finance:'#0ea5e9',Retail:'#f59e0b',Health:'#10b981',Staples:'#84cc16',Energy:'#ef4444',Industrials:'#94a3b8',Materials:'#78716c',REIT:'#c084fc',Other:'#64748b'};
const F="'Instrument Sans','DM Sans',system-ui,sans-serif";
const M="'DM Mono','JetBrains Mono',monospace";
const TH={padding:"10px 12px",textAlign:"right",borderBottom:"2px solid #e2e8f0",fontSize:10,fontWeight:700,color:"#475569",textTransform:"uppercase",letterSpacing:.5,whiteSpace:"nowrap"};
const DTAG={display:"inline-block",fontSize:8,color:"#94a3b8",fontWeight:500,background:"rgba(148,163,184,.12)",padding:"1px 5px",borderRadius:3,marginLeft:4,verticalAlign:"middle",textTransform:"none",letterSpacing:0};

/* ═══════════════════════════════════════════ */
export default function PortfolioDashboard() {
  const [stocks, setStocks] = useState({});
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(null);
  const [error, setError] = useState("");
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState("maxSharpe");
  const [numSims, setNumSims] = useState(3000);

  const tickers = useMemo(() => Object.keys(stocks), [stocks]);

  const addTicker = useCallback(async () => {
    const t = input.toUpperCase().trim();
    if (!t) return;
    if (stocks[t]) { setError(t + " already added"); return; }
    setError("");
    setLoading(t);
    setInput("");
    const data = await fetchPrice(t);
    if (!data) {
      setError("Could not fetch price for " + t + ". Check the ticker symbol.");
    } else {
      setStocks(prev => ({
        ...prev,
        [data.symbol]: {
          ticker: data.symbol, name: data.name, price: data.price,
          source: "Yahoo Finance", date: data.date,
          sector: guessSector(data.symbol),
          entryPrice: data.price,
          targetPrice: "",
          tiprank: "",
          analystRec: "",
        }
      }));
    }
    setLoading(null);
  }, [input, stocks]);

  const removeTicker = useCallback((t) => {
    setStocks(prev => { const n = { ...prev }; delete n[t]; return n; });
    setRes(null);
  }, []);

  const updateField = useCallback((ticker, field, value) => {
    setStocks(prev => ({ ...prev, [ticker]: { ...prev[ticker], [field]: value } }));
  }, []);

  const getRR = (s) => {
    const entry = parseFloat(s.entryPrice);
    const target = parseFloat(s.targetPrice);
    const price = s.price;
    if (!entry || !target || !price || isNaN(entry) || isNaN(target)) return null;
    const risk = price - entry;
    if (risk <= 0) return Infinity;
    return (target - price) / risk;
  };

  const runOptimize = useCallback(async () => {
    if (tickers.length < 2) return;
    setBusy(true);
    await new Promise(r => setTimeout(r, 30));
    setRes(optimize(tickers, numSims));
    setBusy(false);
    setTab("maxSharpe");
  }, [tickers, numSims]);

  const port = res ? (tab === "maxSharpe" ? res.maxSharpe : res.minVar) : null;
  const rows = useMemo(() => {
    if (!port) return [];
    return tickers.map((t, i) => ({ ...stocks[t], w: port.weights[i] || 0 })).sort((a, b) => b.w - a.w);
  }, [port, tickers, stocks]);

  const fmt = v => (v == null || isNaN(v)) ? "\u2014" : (v * 100).toFixed(2) + "%";
  const fN = v => (v == null || isNaN(v)) ? "\u2014" : v.toFixed(3);
  const dataDate = useMemo(() => {
    const d = tickers.map(t => stocks[t]?.date).filter(Boolean);
    return d[0] || new Date().toLocaleDateString();
  }, [tickers, stocks]);

  const recOptions = ["Strong Buy","Buy","Hold","Sell","Strong Sell"];
  const recColors = {"Strong Buy":"#059669","Buy":"#10b981","Hold":"#eab308","Sell":"#f87171","Strong Sell":"#ef4444"};

  return (
    <div style={{fontFamily:F,minHeight:"100vh",background:"linear-gradient(170deg,#080f1a 0%,#0f1a2e 40%,#0a1020 100%)",color:"#e2e8f0",padding:"28px 16px"}}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=DM+Sans:wght@400;500;600;700&family=Instrument+Sans:wght@400;500;600;700&display=swap" rel="stylesheet"/>
      <div style={{maxWidth:1200,margin:"0 auto"}}>

        {/* Header */}
        <div style={{marginBottom:28,display:"flex",alignItems:"flex-end",justifyContent:"space-between",flexWrap:"wrap",gap:12}}>
          <div>
            <div style={{fontSize:10,fontWeight:700,color:"#f59e0b",letterSpacing:3.5,textTransform:"uppercase",marginBottom:3}}>Portfolio Lab</div>
            <h1 style={{fontSize:26,fontWeight:800,margin:0,background:"linear-gradient(135deg,#f8fafc,#94a3b8)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>Monte Carlo Portfolio Optimizer</h1>
            <p style={{color:"#475569",fontSize:12,margin:"4px 0 0"}}>Live prices via Yahoo Finance</p>
          </div>
          <div style={{fontFamily:M,fontSize:11,color:"#475569",textAlign:"right"}}>
            <div style={{fontWeight:600,color:"#f59e0b"}}>Author: My Name</div>
            <div>RF: {(RF*100).toFixed(1)}%</div>
          </div>
        </div>

        {/* Add Stocks */}
        <div style={{background:"rgba(255,255,255,.03)",border:"1px solid rgba(255,255,255,.08)",borderRadius:16,padding:22,marginBottom:22}}>
          <h2 style={{fontSize:15,fontWeight:700,margin:"0 0 4px",color:"#f1f5f9"}}>Add Stocks</h2>
          <p style={{fontSize:11,color:"#64748b",margin:"0 0 14px"}}>Enter any ticker. Current price is fetched live. Fill in your entry price, target price, TipRank &amp; analyst rec to see risk/reward.</p>

          <div style={{display:"flex",gap:8,marginBottom:14}}>
            <input type="text" placeholder="Ticker (e.g. AAPL, NVDA)..." value={input}
              onChange={e=>setInput(e.target.value.toUpperCase())}
              onKeyDown={e=>{if(e.key==="Enter")addTicker();}}
              disabled={!!loading}
              style={{flex:1,padding:"11px 14px",fontFamily:M,fontSize:14,fontWeight:600,background:"rgba(255,255,255,.06)",border:"1px solid rgba(255,255,255,.14)",borderRadius:10,color:"#f1f5f9",outline:"none",letterSpacing:1}}
            />
            <button onClick={addTicker} disabled={!!loading||!input.trim()}
              style={{padding:"11px 24px",borderRadius:10,border:"none",fontWeight:700,fontSize:13,fontFamily:F,cursor:loading?"wait":"pointer",background:loading?"#334155":"linear-gradient(135deg,#f59e0b,#d97706)",color:"#fff",transition:"all .2s",boxShadow:loading?"none":"0 3px 16px rgba(245,158,11,.25)"}}>
              {loading ? "Fetching "+loading+"..." : "+ Add Stock"}
            </button>
          </div>

          {error && <div style={{fontSize:12,color:"#f87171",marginBottom:10,padding:"6px 12px",background:"rgba(239,68,68,.08)",borderRadius:8}}>{error}</div>}

          {/* Chips */}
          {tickers.length > 0 ? (
            <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:16}}>
              {tickers.map(t=>{const s=stocks[t];return(
                <div key={t} style={{display:"flex",alignItems:"center",gap:8,padding:"6px 8px 6px 12px",borderRadius:10,border:"1px solid rgba(255,255,255,.12)",background:"rgba(255,255,255,.04)"}}>
                  <div style={{width:3,height:22,borderRadius:2,background:SEC_CLR[s.sector]||"#64748b"}}/>
                  <div>
                    <div style={{fontFamily:M,fontWeight:700,fontSize:13,color:"#f1f5f9"}}>{t}</div>
                    <div style={{fontSize:9,color:"#64748b"}}>{s.name}</div>
                  </div>
                  <div style={{textAlign:"right",marginLeft:6}}>
                    <div style={{fontFamily:M,fontWeight:700,fontSize:13,color:"#10b981"}}>${s.price?.toFixed(2)}</div>
                    <div style={{fontSize:8,color:"#475569"}}>{s.date}</div>
                  </div>
                  <button onClick={()=>removeTicker(t)} style={{width:18,height:18,borderRadius:9,border:"none",marginLeft:4,background:"rgba(239,68,68,.15)",color:"#f87171",fontSize:12,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",fontWeight:700,padding:0}}>&times;</button>
                </div>
              );})}
            </div>
          ) : (
            <div style={{padding:"20px 0",textAlign:"center",color:"#334155",fontSize:13}}>No stocks added yet.</div>
          )}

          {/* ════════ ANALYSIS TABLE ════════ */}
          {tickers.length > 0 && (
            <div style={{marginTop:16,marginBottom:20}}>
              <h3 style={{fontSize:13,fontWeight:700,color:"#f1f5f9",marginBottom:10}}>Stock Analysis &amp; Targets</h3>
              <div style={{background:"#fff",borderRadius:12,overflow:"hidden",border:"1px solid #e2e8f0"}}>
                <div style={{overflowX:"auto"}}>
                  <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
                    <thead>
                      <tr style={{background:"#f8fafc"}}>
                        <th style={{...TH,textAlign:"left"}}>Ticker</th>
                        <th style={TH}>Current Price <span style={DTAG}>{dataDate}</span></th>
                        <th style={TH}>Entry Price <span style={DTAG}>{dataDate}</span></th>
                        <th style={TH}>Target Price <span style={DTAG}>12mo</span></th>
                        <th style={TH}>TipRank <span style={DTAG}>1-10</span></th>
                        <th style={TH}>Analyst Rec <span style={DTAG}>Consensus</span></th>
                        <th style={TH}>Risk/Reward <span style={DTAG}>Auto</span></th>
                      </tr>
                    </thead>
                    <tbody>
                      {tickers.map((t,idx)=>{
                        const s=stocks[t];
                        const rr=getRR(s);
                        const rrStr=rr===null?"\u2014":rr===Infinity?"\u221E":rr.toFixed(2);
                        const rrColor=rr===null?"#94a3b8":rr===Infinity?"#059669":rr>=2?"#059669":rr>=1?"#eab308":"#ef4444";
                        const rrLabel=rr===null?"Enter target":rr===Infinity?"No downside":rr>=2?"Favorable":rr>=1?"Acceptable":"Unfavorable";
                        const recColor=recColors[s.analystRec]||"#94a3b8";
                        const inputBase={padding:"5px 7px",fontFamily:M,fontSize:11,fontWeight:600,border:"1px solid #e2e8f0",borderRadius:5,color:"#334155",outline:"none"};

                        return(
                          <tr key={t} style={{background:idx%2===0?"#fff":"#fafbfc",borderBottom:"1px solid #f1f5f9"}}>
                            {/* Ticker */}
                            <td style={{padding:"10px 12px",fontWeight:700,color:"#0f172a"}}>
                              <div style={{display:"flex",alignItems:"center",gap:7}}>
                                <div style={{width:3,height:22,borderRadius:2,background:SEC_CLR[s.sector]||"#94a3b8"}}/>
                                <div>
                                  <div style={{fontFamily:M,fontSize:12}}>{t}</div>
                                  <div style={{fontSize:9,color:"#94a3b8",fontWeight:400,maxWidth:100,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{s.name}</div>
                                </div>
                              </div>
                            </td>
                            {/* Current Price */}
                            <td style={{padding:"10px 12px",textAlign:"right"}}>
                              <div style={{fontFamily:M,fontWeight:700,color:"#059669",fontSize:13}}>${s.price?.toFixed(2)}</div>
                              <div style={{fontSize:8,color:"#94a3b8"}}>{s.source}</div>
                            </td>
                            {/* Entry Price */}
                            <td style={{padding:"10px 12px",textAlign:"right"}}>
                              <input type="number" step="0.01" value={s.entryPrice} placeholder="0.00"
                                onChange={e=>updateField(t,"entryPrice",e.target.value)}
                                style={{...inputBase,width:78,textAlign:"right",background:"rgba(99,102,241,.05)"}}/>
                            </td>
                            {/* Target Price */}
                            <td style={{padding:"10px 12px",textAlign:"right"}}>
                              <input type="number" step="0.01" value={s.targetPrice} placeholder="0.00"
                                onChange={e=>updateField(t,"targetPrice",e.target.value)}
                                style={{...inputBase,width:78,textAlign:"right",background:s.targetPrice?"rgba(16,185,129,.07)":"rgba(245,158,11,.07)",borderColor:s.targetPrice?"#e2e8f0":"#fcd34d"}}/>
                              {!s.targetPrice && <div style={{fontSize:8,color:"#f59e0b",marginTop:2}}>Required</div>}
                            </td>
                            {/* TipRank */}
                            <td style={{padding:"10px 12px",textAlign:"center"}}>
                              <input type="text" maxLength={4} value={s.tiprank} placeholder="--"
                                onChange={e=>updateField(t,"tiprank",e.target.value)}
                                style={{...inputBase,width:44,textAlign:"center",background:s.tiprank?"rgba(16,185,129,.07)":"rgba(99,102,241,.03)"}}/>
                              {s.tiprank && <div style={{fontSize:8,color:"#94a3b8",marginTop:1}}>/ 10</div>}
                            </td>
                            {/* Analyst Rec */}
                            <td style={{padding:"10px 12px",textAlign:"center"}}>
                              <div style={{display:"flex",flexWrap:"wrap",gap:3,justifyContent:"center"}}>
                                {recOptions.map(opt=>(
                                  <button key={opt} onClick={()=>updateField(t,"analystRec",s.analystRec===opt?"":opt)}
                                    style={{
                                      padding:"3px 6px",borderRadius:4,border:"1px solid",fontSize:9,fontWeight:600,fontFamily:F,cursor:"pointer",transition:"all .15s",lineHeight:1.2,
                                      borderColor:s.analystRec===opt?recColors[opt]:"#e2e8f0",
                                      background:s.analystRec===opt?recColors[opt]+"20":"#fff",
                                      color:s.analystRec===opt?recColors[opt]:"#94a3b8",
                                    }}>
                                    {opt.replace("Strong ","\u2B50")}
                                  </button>
                                ))}
                              </div>
                            </td>
                            {/* Risk/Reward */}
                            <td style={{padding:"10px 12px",textAlign:"right"}}>
                              <div style={{fontFamily:M,fontSize:14,fontWeight:700,color:rrColor}}>{rrStr}</div>
                              <div style={{fontSize:8,color:rrColor,opacity:.8}}>{rrLabel}</div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div style={{padding:"8px 12px",background:"#f8fafc",fontSize:9,color:"#64748b",borderTop:"1px solid #e2e8f0"}}>
                  R/R = (Target &minus; Current) / (Current &minus; Entry). <span style={{color:"#059669",fontWeight:600}}>&ge;2 Favorable</span> &middot; <span style={{color:"#eab308",fontWeight:600}}>&ge;1 Acceptable</span> &middot; <span style={{color:"#ef4444",fontWeight:600}}>&lt;1 Unfavorable</span>. Enter a target price to see risk/reward.
                </div>
              </div>
            </div>
          )}

          {/* Sims */}
          <div style={{marginBottom:16,marginTop:16}}>
            <label style={{display:"block",fontSize:11,color:"#94a3b8",marginBottom:6,fontWeight:600}}>Simulations (100-5000)</label>
            <input type="number" min="100" max="5000" step="100" value={numSims}
              onChange={e=>setNumSims(Math.min(Math.max(parseInt(e.target.value)||100,100),5000))}
              style={{width:180,padding:"9px 12px",fontFamily:M,fontSize:13,fontWeight:600,background:"rgba(255,255,255,.06)",border:"1px solid rgba(255,255,255,.14)",borderRadius:8,color:"#f1f5f9",outline:"none"}}/>
          </div>

          <button onClick={runOptimize} disabled={busy||tickers.length<2}
            style={{padding:"12px 30px",borderRadius:12,border:"none",fontWeight:700,fontSize:14,fontFamily:F,cursor:(busy||tickers.length<2)?"not-allowed":"pointer",background:busy?"#334155":tickers.length<2?"#1e293b":"linear-gradient(135deg,#818cf8,#6366f1)",color:tickers.length<2?"#475569":"#fff",boxShadow:(busy||tickers.length<2)?"none":"0 4px 20px rgba(99,102,241,.3)"}}>
            {busy?"Optimizing...":tickers.length<2?"Need 2+ stocks (have "+tickers.length+")":"Optimize "+tickers.length+" Stocks"}
          </button>
        </div>

        {/* ═══ RESULTS ═══ */}
        {res&&(<>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(175px,1fr))",gap:12,marginBottom:20}}>
            {[
              {l:"Min Var Return",v:fmt(res.minVar.ret),s:"Vol: "+fmt(res.minVar.vol),c:"#10b981"},
              {l:"Min Var Sharpe",v:fN(res.minVar.sharpe),c:"#10b981"},
              {l:"Max Sharpe Return",v:fmt(res.maxSharpe.ret),s:"Vol: "+fmt(res.maxSharpe.vol),c:"#f59e0b"},
              {l:"Max Sharpe Ratio",v:fN(res.maxSharpe.sharpe),c:"#f59e0b"},
              {l:"Avg MSR Return",v:fmt(res.avgMSR),s:"Avg MVR: "+fmt(res.avgMVR),c:"#818cf8"},
              {l:"Avg Sharpe",v:fN(res.avgSh),s:numSims+" sims",c:"#818cf8"},
            ].map((card,i)=>(
              <div key={i} style={{background:"#fff",borderRadius:14,padding:"16px 18px",border:"1px solid #e2e8f0",position:"relative",overflow:"hidden"}}>
                <div style={{position:"absolute",top:0,left:0,width:4,height:"100%",background:card.c}}/>
                <div style={{fontSize:10,color:"#94a3b8",fontWeight:700,textTransform:"uppercase",letterSpacing:1.2,marginBottom:5}}>{card.l}</div>
                <div style={{fontSize:22,fontWeight:800,color:"#0f172a",fontFamily:M}}>{card.v}</div>
                {card.s&&<div style={{fontSize:11,color:"#64748b",marginTop:3}}>{card.s}</div>}
              </div>
            ))}
          </div>

          <div style={{background:"#fff",borderRadius:16,padding:22,marginBottom:20,border:"1px solid #e2e8f0"}}>
            <h3 style={{fontSize:14,fontWeight:700,color:"#0f172a",margin:"0 0 12px"}}>Efficient Frontier</h3>
            <ResponsiveContainer width="100%" height={260}>
              <ScatterChart margin={{top:10,right:20,bottom:40,left:50}}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9"/>
                <XAxis dataKey="x" type="number" name="Vol" unit="%" domain={["auto","auto"]} tick={{fontSize:11,fill:"#64748b"}} label={{value:"Volatility (%)",position:"insideBottom",offset:-12,fontSize:12,fill:"#94a3b8"}}/>
                <YAxis dataKey="y" type="number" name="Ret" unit="%" domain={["auto","auto"]} tick={{fontSize:11,fill:"#64748b"}} label={{value:"Return (%)",angle:-90,position:"insideLeft",fontSize:12,fill:"#94a3b8"}}/>
                <Tooltip formatter={v=>Number(v).toFixed(2)+"%"} contentStyle={{fontSize:12,borderRadius:8,border:"1px solid #e2e8f0"}}/>
                <Legend wrapperStyle={{fontSize:12}}/>
                <Scatter name="Random" data={res.frontier} fill="#cbd5e1" fillOpacity={.3}/>
                <Scatter name="Min Var" data={[{x:+(res.minVar.vol*100).toFixed(3),y:+(res.minVar.ret*100).toFixed(3)}]} fill="#10b981" shape="star"/>
                <Scatter name="Max Sharpe" data={[{x:+(res.maxSharpe.vol*100).toFixed(3),y:+(res.maxSharpe.ret*100).toFixed(3)}]} fill="#f59e0b" shape="star"/>
              </ScatterChart>
            </ResponsiveContainer>
          </div>

          <div style={{display:"flex",gap:4,marginBottom:4,padding:4,background:"rgba(255,255,255,.04)",borderRadius:14,width:"fit-content"}}>
            {[{id:"maxSharpe",l:"Max Sharpe",c:"#f59e0b"},{id:"minVar",l:"Min Variance",c:"#10b981"}].map(tb=>(
              <button key={tb.id} onClick={()=>setTab(tb.id)} style={{padding:"8px 18px",borderRadius:10,border:"none",fontSize:12,fontWeight:700,fontFamily:F,cursor:"pointer",background:tab===tb.id?"rgba(255,255,255,.1)":"transparent",color:tab===tb.id?tb.c:"#64748b"}}>{tb.l}</button>
            ))}
          </div>

          <div style={{background:"#fff",borderRadius:16,overflow:"hidden",border:"1px solid #e2e8f0",marginBottom:20}}>
            <div style={{overflowX:"auto"}}>
              <table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}>
                <thead><tr style={{background:"#f8fafc"}}>
                  {["Stock","Weight","Price","Sector"].map((h,i)=>(
                    <th key={i} style={{padding:"10px",textAlign:i<2?"left":"right",borderBottom:"2px solid #e2e8f0",fontSize:10,fontWeight:700,color:"#475569",textTransform:"uppercase"}}>{h}</th>
                  ))}
                </tr></thead>
                <tbody>
                  {rows.map((r,i)=>(
                    <tr key={r.ticker} style={{background:i%2===0?"#fff":"#fafbfc",borderBottom:"1px solid #f1f5f9"}}>
                      <td style={{padding:"9px 10px",fontWeight:700,color:"#0f172a"}}>
                        <div style={{display:"flex",alignItems:"center",gap:7}}>
                          <div style={{width:3,height:24,borderRadius:2,background:SEC_CLR[r.sector]||"#94a3b8"}}/>
                          <div><div style={{fontFamily:M,fontSize:13}}>{r.ticker}</div><div style={{fontSize:9,color:"#94a3b8"}}>{r.name}</div></div>
                        </div>
                      </td>
                      <td style={{padding:"9px 10px"}}>
                        <div style={{display:"flex",alignItems:"center",gap:7}}>
                          <div style={{width:55,height:5,borderRadius:3,background:"#f1f5f9",overflow:"hidden"}}>
                            <div style={{width:Math.min(r.w*100*3,100)+"%",height:"100%",borderRadius:3,background:tab==="maxSharpe"?"#f59e0b":"#10b981"}}/>
                          </div>
                          <span style={{fontFamily:M,fontWeight:700,color:"#0f172a",fontSize:12}}>{(r.w*100).toFixed(1)}%</span>
                        </div>
                      </td>
                      <td style={{padding:"9px 10px",textAlign:"right"}}><span style={{fontFamily:M,fontWeight:700,color:"#059669"}}>${r.price?.toFixed(2)}</span></td>
                      <td style={{padding:"9px 10px",textAlign:"right"}}><span style={{fontSize:10,padding:"2px 8px",borderRadius:5,fontWeight:600,background:(SEC_CLR[r.sector]||"#64748b")+"18",color:SEC_CLR[r.sector]||"#64748b"}}>{r.sector}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{borderTop:"2px solid #e2e8f0",background:"#f8fafc",padding:"12px 16px"}}>
              <div style={{fontSize:10,color:"#94a3b8",fontWeight:700,textTransform:"uppercase",letterSpacing:1,marginBottom:6}}>Allocation per $10,000</div>
              <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
                {rows.filter(r=>r.w>.01).map(r=>(
                  <div key={r.ticker} style={{fontFamily:M,fontSize:12,padding:"3px 8px",borderRadius:6,background:"rgba(99,102,241,.06)",color:"#334155"}}>
                    {r.ticker}: <span style={{fontWeight:700,color:"#6366f1"}}>${(r.w*10000).toFixed(0)}</span>
                    <span style={{color:"#94a3b8",fontSize:10}}> ({Math.floor((r.w*10000)/r.price)} sh)</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div style={{background:"rgba(234,179,8,.06)",border:"1px solid rgba(234,179,8,.15)",borderRadius:12,padding:"10px 14px",marginBottom:20,display:"flex",gap:8}}>
            <span style={{fontSize:15}}>&#9888;</span>
            <div style={{fontSize:11,color:"#a16207",lineHeight:1.6}}><strong>Disclaimer:</strong> Prices may be delayed. Monte Carlo uses synthetic returns. Not financial advice.</div>
          </div>
        </>)}

        {!res&&tickers.length>=2&&!busy&&(
          <div style={{background:"rgba(255,255,255,.03)",border:"1px solid rgba(255,255,255,.06)",borderRadius:16,padding:"36px 24px",textAlign:"center"}}>
            <div style={{fontSize:36,marginBottom:10,opacity:.3}}>&#128202;</div>
            <h3 style={{fontSize:16,fontWeight:700,color:"#94a3b8",margin:"0 0 4px"}}>{tickers.length} stocks ready</h3>
            <p style={{fontSize:12,color:"#475569",margin:0}}>Click Optimize to run simulation.</p>
          </div>
        )}
      </div>
    </div>
  );
}
