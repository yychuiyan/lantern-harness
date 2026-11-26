type Props = {
  label?: string;
  className?: string;
  title?: string;
};

const rawBase = import.meta.env.BASE_URL || '/';
export const INSTALL_GUIDE_HREF = `${rawBase.endsWith('/') ? rawBase : `${rawBase}/`}docs/install/`;

export default function LocalDeployGuideLink({
  label = '查看本地部署安装手册',
  className = '',
  title,
}: Props) {
  return (
    <a
      href={INSTALL_GUIDE_HREF}
      title={title}
      className={`inline-flex items-center font-medium text-(--tw-accent) underline decoration-current/40 underline-offset-2 transition-opacity hover:opacity-75 ${className}`}
    >
      {label}
    </a>
  );
}
