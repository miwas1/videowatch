from __future__ import annotations

from django.conf import settings
from django.http import HttpRequest, HttpResponse


class ExtensionCorsMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request: HttpRequest) -> HttpResponse:
        if request.method == "OPTIONS":
            response = HttpResponse(status=204)
        else:
            response = self.get_response(request)

        origin = request.headers.get("Origin")
        if origin and (origin in settings.DESCRIBEOPS_ALLOWED_ORIGINS or origin.startswith("chrome-extension://")):
            response["Access-Control-Allow-Origin"] = origin
            response["Vary"] = "Origin"
            response["Access-Control-Allow-Headers"] = "Content-Type, X-DescribeOps-Token"
            response["Access-Control-Allow-Methods"] = "GET, POST, PATCH, OPTIONS"
            response["Access-Control-Allow-Credentials"] = "false"
        return response

