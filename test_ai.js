const B='http://localhost:3999';let fails=0,passes=0;
async function call(m,p,b,t){const r=await fetch(B+p,{method:m,headers:{'Content-Type':'application/json',...(t?{Authorization:'Bearer '+t}:{})},body:b?JSON.stringify(b):undefined});let j=null;try{j=await r.json()}catch(e){}return{status:r.status,body:j}}
function ok(n,c,x){if(c)passes++;else{fails++;console.log('FAIL:',n,x!==undefined?JSON.stringify(x).slice(0,400):'')}}
const login=async(e)=>(await call('POST','/api/auth/login',{email:e,password:'secret123'})).body.token;
(async()=>{
 const SA=(await call('POST','/api/auth/admin-login',{email:'owner@test.keyarch',password:'Owner@Test2026'})).body.token;
 const P=await login('boss@org.co.tz'), S=await login('boss@std.co.tz');
 let r=await call('GET','/api/ai/status',null,P); ok('pro plan alone does NOT give AI (off by default)',r.status===403,r);
 { const ls=await call('GET','/api/platform/companies',null,SA); const oc=ls.body.companies.find(x=>x.company_name==='Org Co');
   r=await call('PUT','/api/platform/companies/'+oc.company_id,{plan:'PRO',access_status:'ACTIVE',billing_type:'ONE_TIME',features:{ai:true}},SA); ok('super admin switches AI on',r.status===200,r); }
 r=await call('GET','/api/ai/status',null,P); ok('pro status',r.status===200&&r.body.configured===true&&r.body.limit===300,r);
 r=await call('GET','/api/ai/status',null,S); ok('standard locked',r.status===403&&r.body.code==='FEATURE_LOCKED',r);
 r=await call('POST','/api/ai/chat',{messages:[{role:'user',content:'Habari'}]},S); ok('standard chat locked',r.status===403,r);
 r=await call('POST','/api/ai/chat',{messages:[{role:'user',content:'Hali ya kampuni?'}],lang:'sw'},P);
 ok('chat ok',r.status===200&&/RESULTS:/.test(r.body.reply)&&r.body.used===1,r);
 const rep=r.body.reply||''; ok('overview returned',/occupancy_percent/.test(rep),rep.slice(0,300));
 ok('debtors returned',/total_debtors/.test(rep)); ok('vacant returned',/vacant_units|count.{3,12}units/.test(rep)); ok('find no match',/matches/.test(rep)); ok('unknown tool handled',/Unknown tool/.test(rep)); ok('lang in prompt',/SYS:You are the KEY ARCH/.test(rep));
 r=await call('POST','/api/ai/chat',{messages:[]},P); ok('empty rejected',r.status===400,r);
 r=await call('POST','/api/ai/chat',{messages:[{role:'assistant',content:'x'}]},P); ok('must end with user',r.status===400,r);
 r=await call('POST','/api/ai/chat',{messages:[{role:'user',content:'FAIL please'}]},P); ok('provider error is 502 and not counted',r.status===502&&!/boom/.test(JSON.stringify(r.body)),r);
 r=await call('GET','/api/ai/status',null,P); ok('usage counted once',r.body.used===1,r.body);
 r=await call('POST','/api/ai/chat',{messages:[{role:'user',content:'a'},{role:'user',content:'b'},{role:'assistant',content:'c'},{role:'user',content:'d'}]},P); ok('history merged ok',r.status===200,r);
 // scoped manager (Project C only) must see only Project C
 const MC=await login('mc@org.co.tz'); r=await call('POST','/api/ai/chat',{messages:[{role:'user',content:'x'}]},MC); const rr=(r.body&&r.body.reply||'').replace(/\\\\\\"/g,'"');
 ok('scoped chat ok',r.status===200,r); ok('scoped overview not the whole company',/properties\W+2\b/.test(rr),rr.slice(0,200)); ok('scoped sees no other project',!/Project A|Project B/.test(rr),rr.slice(0,400)); ok('scoped sees own debtor',/Tenant C/.test(rr));
 // limit
 const list=await call('GET','/api/platform/companies',null,SA); const c=list.body.companies.find(x=>x.company_name==='Org Co');
 r=await call('PUT','/api/platform/companies/'+c.company_id,{plan:'PRO',access_status:'ACTIVE',billing_type:'ONE_TIME',features:{ai:true,max_ai_questions:2}},SA); ok('set limit',r.status===200,r);
 r=await call('POST','/api/ai/chat',{messages:[{role:'user',content:'again'}]},P); ok('limit reached 429',r.status===429&&r.body.code==='AI_LIMIT',r);
 r=await call('PUT','/api/platform/companies/'+c.company_id,{plan:'PRO',access_status:'ACTIVE',billing_type:'ONE_TIME',features:{ai:false}},SA);
 r=await call('GET','/api/ai/status',null,P); ok('super admin can switch off',r.status===403,r);
 r=await call('POST','/api/ai/chat',{messages:[{role:'user',content:'x'}]},null); ok('no token 401',r.status===401||r.status===403,r);
 console.log('AI PASS',passes,'FAIL',fails);
})();
