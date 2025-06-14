const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

mongoose.connect('mongodb://localhost/cleaning_app', { useNewUrlParser: true, useUnifiedTopology: true });
const db = mongoose.connection;
db.on('error', console.error.bind(console, 'MongoDB connection error:'));

const employeeSchema = new mongoose.Schema({
    name: String,
    telegramId: String
});
const managerSchema = new mongoose.Schema({
    username: String,
    password: String,
    name: String,
    isAdmin: Boolean
});
const Employee = mongoose.model('Employee', employeeSchema);
const Manager = mongoose.model('Manager', managerSchema);

async function seedData() {
    await Employee.deleteMany({});
    await Manager.deleteMany({});

    const employees = [
        { name: 'Иван Иванов', telegramId: '470720833' },
        { name: 'Мария Петрова', telegramId: 'EMPLOYEE2_CHAT_ID' },
        { name: 'Алексей Сидоров', telegramId: 'EMPLOYEE3_CHAT_ID' }
    ];
    await Employee.insertMany(employees);

    const managers = [
        { username: 'manager1', password: await bcrypt.hash('password1', 10), name: 'Анна Смирнова', isAdmin: false },
        { username: 'manager2', password: await bcrypt.hash('password2', 10), name: 'Петр Кузнецов', isAdmin: false },
        { username: 'admin', password: await bcrypt.hash('adminpassword', 10), name: 'Админ', isAdmin: true }
    ];
    await Manager.insertMany(managers);

    console.log('Данные добавлены в базу');
    mongoose.connection.close();
}

seedData();