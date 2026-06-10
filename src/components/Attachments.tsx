import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { chipVariants } from '../lib/motion';
import type { Attachment, AttachmentType } from '../hooks/useAttachments';

interface AttachmentsProps {
  attachments: Attachment[];
  onRemove: (id: string) => void;
  onClickAttachment?: (attachment: Attachment) => void;
}

function getTypeIcon(type: AttachmentType): string {
  switch (type) {
    case 'screenshot': return '⬚';
    case 'clipboard':  return '⎘';
    case 'selection':  return '▤';
    case 'file':       return '⊞';
    default:           return '◈';
  }
}

export const Attachments: React.FC<AttachmentsProps> = ({ attachments, onRemove, onClickAttachment }) => {
  if (attachments.length === 0) return null;

  return (
    <div className="peek-attachments">
      <AnimatePresence mode="popLayout">
        {attachments.map((att) => (
          <motion.div
            key={att.id}
            className="peek-chip"
            onClick={() => onClickAttachment?.(att)}
            style={{ cursor: onClickAttachment ? 'pointer' : 'default' }}
            variants={chipVariants}
            initial="hidden"
            animate="visible"
            exit="exit"
            layout
          >
            <span className="peek-chip-icon" aria-hidden="true">
              {getTypeIcon(att.type)}
            </span>
            <span className="peek-chip-label">{att.label}</span>
            <button
              className="peek-chip-remove"
              onClick={(e) => {
                e.stopPropagation();
                onRemove(att.id);
              }}
              aria-label={`Remove ${att.label}`}
              title="Remove"
            >
              ×
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
};
