// `cloudflare:workers`' `RpcTarget`, in a module of its own: the stack imports `worker.ts` under Node (to plan a deploy),
// which has no such module, so `api-target.ts` loads this one when the first `/mcp` request needs it.
export { RpcTarget } from "cloudflare:workers";
