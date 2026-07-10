import clsx from "clsx";

export function SlackLogo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className={clsx(className)}
    >
      <path
        d="M5.042 15.165a2.528 2.528 0 1 1-2.52-2.523h2.52v2.523ZM6.313 15.165a2.528 2.528 0 1 1 5.056 0v6.313a2.528 2.528 0 0 1-5.056 0v-6.313Z"
        fill="#E01E5A"
      />
      <path
        d="M8.834 5.042a2.528 2.528 0 1 1 2.523-2.52v2.52H8.834ZM8.834 6.313a2.528 2.528 0 0 1 0 5.056H2.522a2.528 2.528 0 0 1 0-5.056h6.313Z"
        fill="#36C5F0"
      />
      <path
        d="M18.957 8.834a2.528 2.528 0 1 1 2.521 2.523h-2.521V8.834ZM17.687 8.834a2.528 2.528 0 1 1-5.056 0V2.521a2.528 2.528 0 1 1 5.056 0v6.313Z"
        fill="#2EB67D"
      />
      <path
        d="M15.165 18.957a2.528 2.528 0 1 1-2.523 2.521v-2.521h2.523ZM15.165 17.687a2.528 2.528 0 0 1 0-5.056h6.313a2.528 2.528 0 1 1 0 5.056h-6.313Z"
        fill="#ECB22E"
      />
    </svg>
  );
}
