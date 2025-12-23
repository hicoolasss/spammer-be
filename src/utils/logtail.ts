import { Logtail } from "@logtail/node";

if (!process.env.LOGTAIL_SOURCE_TOKEN)
  throw new Error("SOURCE_TOKEN is missing");
if (!process.env.LOGTAIL_INTEGRATION_HOST)
  throw new Error("LOGTAIL_ENDPOINT is missing");

const logtail = new Logtail(process.env.LOGTAIL_SOURCE_TOKEN, {
  endpoint: `https://${process.env.LOGTAIL_INTEGRATION_HOST}`,
});

export default logtail;
