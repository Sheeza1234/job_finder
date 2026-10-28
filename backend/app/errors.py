class HttpError(Exception):
    """Raised anywhere in a request; rendered as {"error": message} like the original Express API."""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message
