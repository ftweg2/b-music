// Test-only upstream substitution for the actual standalone production image.
if(process.env.B_MUSIC_HTTP_FIXTURE!=="isolated-only")throw new Error("Fixture preload disabled");
const kernel=new URL(process.env.KERNEL_BASE_URL);
if(kernel.hostname!=="kernel"||kernel.port!=="8000")throw new Error("Isolated Docker network required");
const original=globalThis.fetch;
globalThis.fetch=(input,init)=>{
  const url=new URL(input instanceof Request?input.url:input);
  let target=url;
  if(url.hostname==="api.bilibili.com")target=new URL("/__fixture/upstream"+url.pathname+url.search,kernel);
  else if(/^i[012]\.hdslb\.com$/.test(url.hostname))target=new URL("/__fixture/image/"+url.pathname.split("/").at(-1),kernel);
  else if(url.origin!==kernel.origin&&!(url.origin==="http://127.0.0.1:3000"&&url.pathname==="/api/health"))throw new Error("External network is disabled in fixture");
  return original(input instanceof Request?new Request(target,input):target,init);
};
