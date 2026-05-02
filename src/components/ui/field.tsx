import * as React from 'react';
import { Eyebrow } from './eyebrow';

export interface FieldProps extends React.LabelHTMLAttributes<HTMLLabelElement> {
  label: string;
}

export function Field({ label, children, style, ...rest }: FieldProps) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6, ...style }} {...rest}>
      <Eyebrow>{label}</Eyebrow>
      {children}
    </label>
  );
}

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

export function Input({ style, ...rest }: InputProps) {
  return (
    <input
      style={{
        background: 'var(--bg-card)',
        color: 'var(--fg)',
        border: '1px solid var(--border-strong)',
        borderRadius: 6,
        padding: '9px 12px',
        fontFamily: 'var(--font-ui)',
        fontSize: 14,
        outline: 'none',
        ...style,
      }}
      {...rest}
    />
  );
}

export type TextAreaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

export function TextArea({ style, ...rest }: TextAreaProps) {
  return (
    <textarea
      style={{
        background: 'var(--bg-card)',
        color: 'var(--fg)',
        border: '1px solid var(--border-strong)',
        borderRadius: 6,
        padding: '10px 12px',
        fontFamily: 'var(--font-ui)',
        fontSize: 14,
        outline: 'none',
        resize: 'vertical',
        ...style,
      }}
      {...rest}
    />
  );
}
