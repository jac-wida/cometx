import React, { useEffect, useState, memo } from 'react'
import { AnimatePresence, motion } from 'framer-motion'

function PostDragPreview({ post, show }) {
  const split = post ? post.title.split(' ') : []
  const title = `${split.slice(0, 9).join(' ')}${
    split.length >= 9 ? '...' : ''
  }`

  return (
    <div>
      <AnimatePresence>
        {show && (
          <motion.div
            initial={{
              scale: 0.75,
              opacity: 0
            }}
            animate={{
              scale: 1,
              opacity: 1
            }}
            exit={{
              scale: 0.75,
              opacity: 0
            }}
            transition={{ duration: 0.15, ease: 'easeInOut' }}
            className="bg-blue-500 bg-opacity-75 rounded-md shadow-lg text-white text-sm font-medium h-10 px-6 inline-flex items-center"
          >
            <span className="inline-block">{title}</span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export default React.memo(PostDragPreview)
