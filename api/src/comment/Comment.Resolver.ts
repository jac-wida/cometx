import {
  Arg,
  Args,
  Authorized,
  Ctx,
  FieldResolver,
  ID,
  Mutation,
  Query,
  Resolver,
  Root
} from 'type-graphql'
import { Context } from '@/Context'
import { Comment } from '@/comment/Comment.Entity'
import { SubmitCommentArgs } from '@/comment/SubmitCommentArgs'
import { CommentsArgs } from '@/comment/CommentsArgs'
import { User } from '@/user/User.Entity'
import { Notification } from '@/notification/Notification.Entity'
import { filterXSS } from 'xss'
import { whiteList } from '@/XSSWhiteList'
import { CommentRocket } from '@/comment/CommentRocket.Entity'
import { InjectRepository } from 'typeorm-typedi-extensions'
import { Repository } from 'typeorm'
import { Post } from '@/post/Post.Entity'

function flat(r: any, a: any) {
  const b = {} as any
  Object.keys(a).forEach(function (k) {
    if (k !== 'childComments') {
      b[k] = a[k]
    }
  })
  r.push(b)
  if (Array.isArray(a.childComments)) {
    b.childComments = a.childComments.map(function (a: any) {
      return a.id
    })
    return a.childComments.reduce(flat, r)
  }
  return r
}

@Resolver(() => Comment)
export class CommentResolver {
  @InjectRepository(User)
  readonly userRepository: Repository<User>
  @InjectRepository(Post)
  readonly postRepository: Repository<Post>
  @InjectRepository(Comment)
  readonly commentRepository: Repository<Comment>
  @InjectRepository(CommentRocket)
  readonly commentRocketRepository: Repository<CommentRocket>
  @InjectRepository(Notification)
  readonly notificationRepository: Repository<Notification>

  @Authorized()
  @Mutation(() => Comment)
  async submitComment(
    @Args() { textContent, postId, parentCommentId }: SubmitCommentArgs,
    @Ctx() { userId }: Context
  ) {
    const post = await this.postRepository
      .createQueryBuilder('post')
      .where('post.id  = :postId', { postId })
      .leftJoinAndSelect('post.planet', 'planet')
      // .leftJoinAndSelect('planet.bannedUsers', 'bannedUser')
      .getOne()

    /*const bannedUsers = await (await post.planet).bannedUsers
    if (bannedUsers.map(u => u.id).includes(userId))
      throw new Error(
        'You have been banned from ' + (await post.planet).name
      )*/

    textContent = filterXSS(textContent, { whiteList })

    const savedComment = await this.commentRepository.save({
      textContent,
      parentCommentId,
      postId,
      authorId: userId,

      rocketed: true,
      rocketCount: 1
    })

    this.commentRocketRepository.save({
      commentId: savedComment.id,
      userId
    } as CommentRocket)

    this.userRepository.increment({ id: userId }, 'rocketCount', 1)

    this.postRepository.increment({ id: postId }, 'commentCount', 1)

    if (parentCommentId) {
      const parentComment = await this.commentRepository.findOne(
        parentCommentId
      )
      if (parentComment.authorId !== userId) {
        this.notificationRepository.save({
          commentId: savedComment.id,
          fromUserId: userId,
          toUserId: parentComment.authorId,
          postId,

          parentCommentId
        } as Notification)
      }
    } else {
      const post = await this.postRepository.findOne(postId)
      if (post.authorId !== userId) {
        this.notificationRepository.save({
          commentId: savedComment.id,
          fromUserId: userId,
          toUserId: post.authorId,
          postId
        } as Notification)
      }
    }

    return savedComment
  }

  @Query(() => [Comment])
  async comments(
    @Args() { postId, sort }: CommentsArgs,
    @Ctx() { userId }: Context
  ) {
    postId = parseInt(postId, 36)

    const post = await this.postRepository.findOne({ id: postId })

    if (!post) return []

    const qb = await this.commentRepository
      .createQueryBuilder('comment')
      .where('comment.postId = :postId', { postId: post.id })

    if (userId) {
      const blockTo = (
        await this.userRepository
          .createQueryBuilder()
          .relation(User, 'blockTo')
          .of(userId)
          .loadMany()
      ).map(user => user.id)

      qb.andWhere('NOT (comment.authorId = ANY(:blockTo))', {
        blockTo
      })
    }

    /*if (sort === Sort.TOP) {
      qb.addOrderBy('comment.rocketCount', 'DESC')
    }*/

    qb.addOrderBy('comment.createdAt', 'DESC')
    qb.addOrderBy('comment.rocketCount', 'DESC')

    const comments = await qb.getMany()

    comments.forEach(comment => {
      if (comment.deleted) {
        comment.textContent = `<p>[deleted]</p>`
        comment.authorId = null
        comment.author = null
      }
      if (comment.removed) {
        comment.textContent = `<p>[removed: ${comment.removedReason}]</p>`
        comment.authorId = null
        comment.author = null
      }
    })

    return comments
  }

  @Authorized()
  @Mutation(() => Boolean)
  async deleteComment(
    @Arg('commentId', () => ID) commentId: number,
    @Ctx() { userId }: Context
  ) {
    const comment = await this.commentRepository.findOne(commentId)
    const user = await this.userRepository.findOne(userId)
    if (comment.authorId !== userId && !user.admin)
      throw new Error('Attempt to delete post by someone other than author')

    this.postRepository.decrement({ id: comment.postId }, 'commentCount', 1)

    await this.commentRepository
      .createQueryBuilder()
      .update()
      .set({ deleted: true })
      .where('id = :commentId', { commentId })
      .execute()

    return true
  }

  @Authorized()
  @Mutation(() => Boolean)
  async editComment(
    @Arg('commentId', () => ID) commentId: number,
    @Arg('newTextContent') newTextContent: string,
    @Ctx() { userId }: Context
  ) {
    const comment = await this.commentRepository.findOne(commentId)
    const user = await this.userRepository.findOne(userId)
    if (comment.authorId !== userId && !user.admin)
      throw new Error('Attempt to edit post by someone other than author')

    newTextContent = filterXSS(newTextContent, { whiteList })

    await this.commentRepository
      .createQueryBuilder()
      .update()
      .set({ editedAt: new Date(), textContent: newTextContent })
      .where('id = :commentId', { commentId })
      .execute()

    return true
  }

  @Authorized()
  @Mutation(() => Boolean)
  async toggleCommentRocket(
    @Arg('commentId', () => ID) commentId: number,
    @Ctx() { userId }: Context
  ) {
    const comment = await this.commentRepository
      .createQueryBuilder('comment')
      .whereInIds(commentId)
      .leftJoinAndSelect('comment.author', 'author')
      .getOne()
    if (!comment) throw new Error('Comment not found')

    const rocket = await this.commentRocketRepository.findOne({
      commentId,
      userId
    })
    if (rocket) {
      await this.commentRocketRepository.delete({ commentId, userId })
    } else {
      await this.commentRocketRepository.save({
        commentId,
        userId
      })
    }

    this.commentRepository.update(
      { id: commentId },
      {
        rocketCount: rocket ? comment.rocketCount - 1 : comment.rocketCount + 1
      }
    )

    const author = await comment.author
    this.userRepository.update(
      { id: author.id },
      {
        rocketCount: rocket ? author.rocketCount - 1 : author.rocketCount + 1
      }
    )

    return !rocket
  }

  @Authorized()
  @Mutation(() => Boolean)
  async saveComment(
    @Arg('commentId', () => ID) commentId: number,
    @Ctx() { userId }: Context
  ) {
    await this.userRepository
      .createQueryBuilder()
      .relation(User, 'savedComments')
      .of(userId)
      .remove(commentId)

    await this.userRepository
      .createQueryBuilder()
      .relation(User, 'savedComments')
      .of(userId)
      .add(commentId)
    return true
  }

  @Authorized()
  @Mutation(() => Boolean)
  async unsaveComment(
    @Arg('commentId', () => ID) commentId: number,
    @Ctx() { userId }: Context
  ) {
    await this.userRepository
      .createQueryBuilder()
      .relation(User, 'savedComments')
      .of(userId)
      .remove(commentId)
    return true
  }

  @FieldResolver()
  async author(@Root() comment: Comment, @Ctx() { userLoader }: Context) {
    if (!comment.authorId) return null
    return userLoader.load(comment.authorId)
  }

  @FieldResolver()
  async post(@Root() comment: Comment, @Ctx() { postLoader }: Context) {
    return postLoader.load(comment.postId)
  }

  @FieldResolver()
  async rocketed(
    @Root() comment: Comment,
    @Ctx() { commentRocketLoader, userId }: Context
  ) {
    if (!userId) return false
    return commentRocketLoader.load({ userId, commentId: comment.id })
  }
}
