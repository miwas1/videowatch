from __future__ import annotations

import logging
import time

from django.core.management.base import BaseCommand

from reader.services.jobs import run_next_job

logger = logging.getLogger("describeops.worker")


class Command(BaseCommand):
    help = "Run DescribeOps queued media processing jobs."

    def add_arguments(self, parser) -> None:
        parser.add_argument("--once", action="store_true", help="Run at most one queued job and exit.")
        parser.add_argument("--idle-sleep", type=float, default=2.0, help="Seconds to sleep when no job is queued.")

    def handle(self, *args, **options) -> None:
        once = bool(options["once"])
        idle_sleep = float(options["idle_sleep"])
        self.stdout.write(self.style.SUCCESS("DescribeOps worker started."))
        logger.info("Worker started (once=%s, idle_sleep=%.1f)", once, idle_sleep)
        while True:
            job = run_next_job()
            if job is None:
                if once:
                    self.stdout.write("No queued jobs.")
                    return
                time.sleep(idle_sleep)
                continue
            msg = f"job={job.id} type={job.job_type} status={job.status} session={job.session_id}"
            if job.status == "failed":
                logger.error("Job failed: %s error=%s", msg, job.error_message[:200])
                self.stdout.write(self.style.ERROR(f"FAILED {msg}"))
            else:
                logger.info("Job completed: %s", msg)
                self.stdout.write(self.style.SUCCESS(f"OK {msg}"))
            if once:
                return
