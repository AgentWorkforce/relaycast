// @handler /api/v1/workflows/run
process.env.NEXT_PUBLIC_APP_URL ??= "https://cloud.test";

import "../../../../tests/workflow-run-route.test";
