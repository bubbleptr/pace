import { hostAddress } from "./host-address.ts";

const { url, token } = await hostAddress(process.argv.slice(2));
const web = new URL("http://127.0.0.1:5199/");
web.hash = new URLSearchParams({ token, url }).toString();
// Deliberately requested by the operator, never emitted by the host's routine logs.
console.log(web.href);
