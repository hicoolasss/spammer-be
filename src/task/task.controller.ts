import { CurrentUser } from '@_decorators';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CreateTaskDto, TaskDto, TaskListResponseDto, UpdateTaskDto } from '@task/dto/task.dto';
import { TaskService } from '@task/task.service';
import { UserDto } from '@user/dto/user.dto';

@Controller('tasks')
export class TaskController {
  constructor(private readonly taskService: TaskService) {}

  @Post()
  async createTask(@Body() dto: CreateTaskDto, @CurrentUser() user: UserDto): Promise<TaskDto> {
    console.log(dto);
    return await this.taskService.createTask(dto, user._id);
  }

  @Delete(':id')
  async deleteTask(@CurrentUser() user: UserDto, @Param('id') id: string): Promise<void> {
    return await this.taskService.deleteTask(id);
  }

  @Patch(':id')
  async updateTask(@Param('id') id: string, @Body() dto: UpdateTaskDto): Promise<TaskDto> {
    return await this.taskService.updateTask(id, dto);
  }

  @Get()
  async getTasks(
    @CurrentUser() user: UserDto,
    @Query('skip', new ParseIntPipe({ errorHttpStatusCode: HttpStatus.BAD_REQUEST }))
    skip: number = 0,
    @Query('limit', new ParseIntPipe({ errorHttpStatusCode: HttpStatus.BAD_REQUEST }))
    limit: number = 10,
    @Query('searchQuery') searchQuery?: string,
    @Query('selectedGeo') selectedGeo?: string,
  ): Promise<TaskListResponseDto> {
    return await this.taskService.findAllByUser(user._id, skip, limit, searchQuery, selectedGeo);
  }
}
