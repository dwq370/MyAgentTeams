import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { InjectRepository } from "@nestjs/typeorm";
import * as bcrypt from "bcrypt";
import { Repository } from "typeorm";
import { DomainError } from "../domain/errors";
import { UserEntity } from "../entities";

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async register(input: { email: string; password: string; name: string }) {
    const email = input.email.trim().toLowerCase();
    const existing = await this.users.findOne({ where: { email } });
    if (existing) throw new DomainError("邮箱已注册", 409);
    const user = await this.users.save(
      this.users.create({
        email,
        name: input.name.trim(),
        passwordHash: await bcrypt.hash(input.password, 10),
      }),
    );
    return this.issue(user);
  }

  async login(input: { email: string; password: string }) {
    const email = input.email.trim().toLowerCase();
    const user = await this.users
      .createQueryBuilder("user")
      .addSelect("user.passwordHash")
      .where("user.email = :email", { email })
      .getOne();
    if (!user || !(await bcrypt.compare(input.password, user.passwordHash))) {
      throw new DomainError("邮箱或密码不正确", 401);
    }
    return this.issue(user);
  }

  async me(userId: string) {
    const user = await this.users.findOne({ where: { id: userId } });
    if (!user) throw new DomainError("用户不存在", 404);
    return { id: user.id, email: user.email, name: user.name };
  }

  private issue(user: UserEntity) {
    const accessToken = this.jwt.sign({ sub: user.id, email: user.email, name: user.name });
    return { accessToken, user: { id: user.id, email: user.email, name: user.name } };
  }
}
