ALTER TABLE "agent_deployment_runs" ALTER COLUMN "stdout" DROP NOT NULL;
ALTER TABLE "agent_deployment_runs" ALTER COLUMN "stderr" DROP NOT NULL;
ALTER TABLE "agent_deployment_runs" ALTER COLUMN "mount_log_tail" DROP NOT NULL;
