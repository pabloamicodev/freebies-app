interface NotFoundProps {
  message?: string;
}

export function NotFound({ message = "Not found." }: NotFoundProps) {
  return (
    <div className="b-page">
      <p className="b-text-sub">{message}</p>
    </div>
  );
}
